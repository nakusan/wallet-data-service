import type { Pool } from 'pg';
import type { Env } from '../config/env.js';
import type { ChainClients } from './chain/viem-client.js';
import { getSafeBlockNumber, getFinalizedBlockNumber } from './chain/viem-client.js';
import { Erc20BalanceRewinder, NftHoldingRewinder } from '../wallet/sync/materialization-rewinder.js';
import { ContractRepo } from './db/contract-repo.js';
import { CheckpointRepo } from './db/checkpoint-repo.js';
import { ChainStateRepo } from './db/chain-state-repo.js';
import { BlockAnchorRepo } from './db/block-anchor-repo.js';
import { PartitionRepo } from './db/partition-repo.js';
import { PartitionService } from './service/partition-service.js';
import { ContractWriteCoordinator } from './util/contract-write-coordinator.js';
import {
  ChainReorgCoordinator,
  createChainReorgCoordinator,
} from './service/chain-reorg-coordinator.js';
import { FinalizedPersistService } from './service/finalized-persist-service.js';
import { Erc20TransferRepo } from './erc20/transfer-repo.js';
import { Erc20BackfillService } from './erc20/backfill-service.js';
import { Erc20LiveWatcher } from './erc20/live-watcher.js';
import { NftTransferRepo } from './nft/transfer-repo.js';
import { NftBackfillService } from './nft/backfill-service.js';
import { NftLiveWatcher } from './nft/live-watcher.js';
import type { NftTransferRecord, TransferRecord } from './domain/types.js';
import { logger } from '../infrastructure/logger/logger.js';
import type { WriteSemaphore } from '../infrastructure/db/write-semaphore.js';
import { resolveStartBlock } from './util/resolve-start-block.js';

export class IndexerApp {
  private erc20LiveWatcher: Erc20LiveWatcher | null = null;
  private nftLiveWatcher: NftLiveWatcher | null = null;
  private partitionTimer: ReturnType<typeof setInterval> | null = null;
  private reorgTimer: ReturnType<typeof setInterval> | null = null;
  private gapBackfillTimer: ReturnType<typeof setInterval> | null = null;
  private gapBackfillRunning = false;
  private chainReorgCoordinator: ChainReorgCoordinator | null = null;

  private readonly contractRepo: ContractRepo;
  private readonly checkpointRepo: CheckpointRepo;
  private readonly chainStateRepo: ChainStateRepo;
  private readonly blockAnchorRepo: BlockAnchorRepo;

  private readonly erc20TransferRepo: Erc20TransferRepo;
  private readonly erc20PartitionService: PartitionService;

  private readonly nftTransferRepo: NftTransferRepo;
  private readonly nftPartitionService: PartitionService;

  /** 热层 migration 预建分区下界；用于 start_block 钳制（分区仅向上扩展） */
  private hotPartitionMinBlock: bigint | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly env: Env,
    private readonly chain: ChainClients,
    private readonly writeSemaphore: WriteSemaphore,
  ) {
    this.contractRepo = new ContractRepo(pool);
    this.checkpointRepo = new CheckpointRepo(pool);
    this.chainStateRepo = new ChainStateRepo(pool);
    this.blockAnchorRepo = new BlockAnchorRepo(pool);

    this.erc20TransferRepo = new Erc20TransferRepo(pool);
    this.erc20PartitionService = new PartitionService(
      new PartitionRepo(pool, 'token_transfers'),
      BigInt(env.PARTITION_BLOCK_RANGE),
      writeSemaphore,
    );

    this.nftTransferRepo = new NftTransferRepo(pool);
    this.nftPartitionService = new PartitionService(
      new PartitionRepo(pool, 'nft_transfers'),
      BigInt(env.PARTITION_BLOCK_RANGE),
      writeSemaphore,
    );
  }

  async run(): Promise<void> {
    await this.chainStateRepo.ensureInitialized(this.env.CHAIN_ID);
    await this.chainStateRepo.syncFromContractMinOnPool(this.env.CHAIN_ID);
    await this.updateFinalizedBlock();

    const safeLatest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
    this.hotPartitionMinBlock = await new PartitionRepo(this.pool, 'token_transfers')
      .getMinHotPartitionLowerBound();
    await Promise.all([
      this.erc20PartitionService.ensureThroughWithBuffer(safeLatest),
      this.nftPartitionService.ensureThroughWithBuffer(safeLatest),
    ]);

    const coordinator = createChainReorgCoordinator(
      this.pool, this.env, this.chain.http,
      this.chainStateRepo, this.blockAnchorRepo,
      this.checkpointRepo, this.writeSemaphore,
    );
    this.chainReorgCoordinator = coordinator;

    await this.setupErc20(coordinator);
    await this.setupNft(coordinator);
    await coordinator.scanAndRepair();

    await this.startErc20(safeLatest, coordinator);
    await this.startNft(safeLatest, coordinator);

    this.partitionTimer = setInterval(
      () => void this.runPartitionEnsureTick(),
      this.env.PARTITION_ENSURE_INTERVAL_MS,
    );
    this.reorgTimer = setInterval(
      () => void this.runReorgScanTick(),
      this.env.REORG_SCAN_INTERVAL_MS,
    );
    this.gapBackfillTimer = setInterval(
      () => void this.runGapBackfillTick(),
      this.env.GAP_BACKFILL_INTERVAL_MS,
    );

    logger.info({ safeLatest: safeLatest.toString() }, '索引器（ERC20+NFT）已启动');
  }

  async shutdown(): Promise<void> {
    if (this.gapBackfillTimer) {
      clearInterval(this.gapBackfillTimer);
      this.gapBackfillTimer = null;
    }
    if (this.reorgTimer) {
      clearInterval(this.reorgTimer);
      this.reorgTimer = null;
    }
    if (this.partitionTimer) {
      clearInterval(this.partitionTimer);
      this.partitionTimer = null;
    }
    await this.erc20LiveWatcher?.shutdown();
    await this.nftLiveWatcher?.shutdown();
    logger.info('索引器已关闭');
  }

  private erc20WriteCoordinator: ContractWriteCoordinator | null = null;
  private erc20Backfill: Erc20BackfillService | null = null;
  private erc20Contracts: Awaited<ReturnType<ContractRepo['findActive']>> = [];

  private async setupErc20(coordinator: ChainReorgCoordinator): Promise<void> {
    const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC20');
    if (contracts.length === 0) {
      logger.warn('无活跃 ERC20 合约');
      return;
    }
    this.erc20Contracts = contracts;

    const writeCoordinator = new ContractWriteCoordinator();
    this.erc20WriteCoordinator = writeCoordinator;

    const persistService = new FinalizedPersistService<TransferRecord>(
      this.pool, this.env, this.chain.http,
      this.erc20TransferRepo, this.checkpointRepo,
      this.blockAnchorRepo, this.chainStateRepo,
      this.erc20PartitionService, 'erc20',
      this.writeSemaphore,
    );

    const backfill = new Erc20BackfillService(
      this.env, 
      this.chain.http, 
      writeCoordinator, 
      persistService, 
      coordinator,
    );
    this.erc20Backfill = backfill;

    coordinator.register({
      indexerType: 'erc20',
      writeCoordinator,
      liveWatcher: null,
      repos: [this.erc20TransferRepo],
      rewinders: [new Erc20BalanceRewinder()],
      backfill,
      getContracts: () => this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC20'),
    }, persistService);
  }

  private async startErc20(safeLatest: bigint, coordinator: ChainReorgCoordinator): Promise<void> {
    if (this.erc20Contracts.length === 0 || !this.erc20WriteCoordinator || !this.erc20Backfill) return;

    const writeCoordinator = this.erc20WriteCoordinator;
    const backfill = this.erc20Backfill;
    const contracts = this.erc20Contracts;

    const persistService = new FinalizedPersistService<TransferRecord>(
      this.pool, this.env, this.chain.http,
      this.erc20TransferRepo, this.checkpointRepo,
      this.blockAnchorRepo, this.chainStateRepo,
      this.erc20PartitionService, 'erc20',
      this.writeSemaphore,
    );

    for (const contract of contracts) {
      const checkpoint = await this.checkpointRepo.get(contract.chainId, contract.address, 'erc20');
      const start = resolveStartBlock({
        contract,
        checkpoint,
        safeLatest,
        lookbackBlocks: BigInt(this.env.INDEXER_START_LOOKBACK_BLOCKS),
        hotPartitionMinBlock: this.hotPartitionMinBlock,
      });
      if (start <= safeLatest) await backfill.fillSegmented(contract, start, safeLatest);
    }

    const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
      ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;

    const liveWatcher = new Erc20LiveWatcher(
      this.env, this.chain.ws, writeCoordinator, persistService, coordinator,
      async () => {
        for (const contract of contracts) {
          const checkpoint = await this.checkpointRepo.get(contract.chainId, contract.address, 'erc20');
          const latest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
          const from = resolveStartBlock({
            contract,
            checkpoint,
            safeLatest: latest,
            lookbackBlocks: BigInt(this.env.INDEXER_START_LOOKBACK_BLOCKS),
            hotPartitionMinBlock: this.hotPartitionMinBlock,
          });
          if (from <= latest) await backfill.fillSegmented(contract, from, latest);
        }
      },
    );
    this.erc20LiveWatcher = liveWatcher;
    coordinator.attachLiveWatcher('erc20', liveWatcher);
    liveWatcher.start(contracts, resumeFrom);
  }

  private nftWriteCoordinator: ContractWriteCoordinator | null = null;
  private nftBackfill: NftBackfillService | null = null;
  private nftContracts: Awaited<ReturnType<ContractRepo['findActive']>> = [];

  private async setupNft(coordinator: ChainReorgCoordinator): Promise<void> {
    const contracts721 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC721');
    const contracts1155 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC1155');
    const contracts = [...contracts721, ...contracts1155];
    if (contracts.length === 0) {
      logger.info('无活跃 NFT 合约，跳过 NFT 索引');
      return;
    }
    this.nftContracts = contracts;

    const writeCoordinator = new ContractWriteCoordinator();
    this.nftWriteCoordinator = writeCoordinator;

    const persistService = new FinalizedPersistService<NftTransferRecord>(
      this.pool, this.env, this.chain.http,
      this.nftTransferRepo, this.checkpointRepo,
      this.blockAnchorRepo, this.chainStateRepo,
      this.nftPartitionService, 'nft',
      this.writeSemaphore,
    );

    const backfill = new NftBackfillService(
      this.env, this.chain.http, writeCoordinator, persistService, coordinator, this.nftTransferRepo,
    );
    this.nftBackfill = backfill;

    coordinator.register({
      indexerType: 'nft',
      writeCoordinator,
      liveWatcher: null,
      repos: [this.nftTransferRepo],
      rewinders: [new NftHoldingRewinder()],
      backfill,
      getContracts: async () => {
        const c721 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC721');
        const c1155 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC1155');
        return [...c721, ...c1155];
      },
    }, persistService);
  }

  private async startNft(safeLatest: bigint, coordinator: ChainReorgCoordinator): Promise<void> {
    if (this.nftContracts.length === 0 || !this.nftWriteCoordinator || !this.nftBackfill) return;

    const writeCoordinator = this.nftWriteCoordinator;
    const backfill = this.nftBackfill;
    const contracts = this.nftContracts;

    const persistService = new FinalizedPersistService<NftTransferRecord>(
      this.pool, this.env, this.chain.http,
      this.nftTransferRepo, this.checkpointRepo,
      this.blockAnchorRepo, this.chainStateRepo,
      this.nftPartitionService, 'nft',
      this.writeSemaphore,
    );

    for (const contract of contracts) {
      const checkpoint = await this.checkpointRepo.get(contract.chainId, contract.address, 'nft');
      const start = resolveStartBlock({
        contract,
        checkpoint,
        safeLatest,
        lookbackBlocks: BigInt(this.env.INDEXER_START_LOOKBACK_BLOCKS),
        hotPartitionMinBlock: this.hotPartitionMinBlock,
      });
      if (start <= safeLatest) await backfill.fillSegmented(contract, start, safeLatest);
    }

    const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
      ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;

    const liveWatcher = new NftLiveWatcher(
      this.env, this.chain.ws, writeCoordinator, persistService, coordinator,
      async () => {
        for (const contract of contracts) {
          const checkpoint = await this.checkpointRepo.get(contract.chainId, contract.address, 'nft');
          const latest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
          const from = resolveStartBlock({
            contract,
            checkpoint,
            safeLatest: latest,
            lookbackBlocks: BigInt(this.env.INDEXER_START_LOOKBACK_BLOCKS),
            hotPartitionMinBlock: this.hotPartitionMinBlock,
          });
          if (from <= latest) await backfill.fillSegmented(contract, from, latest);
        }
      },
    );
    this.nftLiveWatcher = liveWatcher;
    coordinator.attachLiveWatcher('nft', liveWatcher);
    liveWatcher.start(contracts, resumeFrom);
  }

  private async runPartitionEnsureTick(): Promise<void> {
    try {
      const safeLatest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
      await Promise.all([
        this.erc20PartitionService.ensureThroughWithBuffer(safeLatest),
        this.nftPartitionService.ensureThroughWithBuffer(safeLatest),
      ]);
      await this.updateFinalizedBlock();
    } catch (err) {
      logger.error({ err }, '定时预创建热分区失败');
    }
  }

  private async updateFinalizedBlock(): Promise<void> {
    const finalized = await getFinalizedBlockNumber(this.chain.http, this.env);
    await this.chainStateRepo.setFinalizedBlock(this.env.CHAIN_ID, finalized);
  }

  private async runReorgScanTick(): Promise<void> {
    try {
      await this.chainReorgCoordinator?.scanAndRepair();
    } catch (err) {
      logger.error({ err }, '定时 reorg 扫描失败');
    }
  }

  /** 定时将各合约 checkpoint 从 checkpoint+1 追至 safeLatest，补全空块 anchor。 */
  private async runGapBackfillTick(): Promise<void> {
    if (this.gapBackfillRunning) return;
    this.gapBackfillRunning = true;
    try {
      const safeLatest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
      await this.gapBackfillErc20(safeLatest);
      await this.gapBackfillNft(safeLatest);
    } catch (err) {
      logger.error({ err }, '定时 gap-backfill 失败');
    } finally {
      this.gapBackfillRunning = false;
    }
  }

  private async gapBackfillErc20(safeLatest: bigint): Promise<void> {
    if (!this.erc20Backfill || this.erc20Contracts.length === 0) return;
    for (const contract of this.erc20Contracts) {
      const checkpoint = await this.checkpointRepo.get(
        contract.chainId, contract.address, 'erc20',
      );
      if (checkpoint == null) continue;
      const from = checkpoint + 1n;
      if (from > safeLatest) continue;
      await this.erc20Backfill.fillSegmented(contract, from, safeLatest);
    }
  }

  private async gapBackfillNft(safeLatest: bigint): Promise<void> {
    if (!this.nftBackfill || this.nftContracts.length === 0) return;
    for (const contract of this.nftContracts) {
      const checkpoint = await this.checkpointRepo.get(
        contract.chainId, contract.address, 'nft',
      );
      if (checkpoint == null) continue;
      const from = checkpoint + 1n;
      if (from > safeLatest) continue;
      await this.nftBackfill.fillSegmented(contract, from, safeLatest);
    }
  }
}
