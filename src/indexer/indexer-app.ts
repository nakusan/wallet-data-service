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
import { ReorgService } from './service/reorg-service.js';
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

export class IndexerApp {
  private erc20LiveWatcher: Erc20LiveWatcher | null = null;
  private nftLiveWatcher: NftLiveWatcher | null = null;
  private partitionTimer: ReturnType<typeof setInterval> | null = null;
  private reorgTimer: ReturnType<typeof setInterval> | null = null;

  private readonly contractRepo: ContractRepo;
  private readonly checkpointRepo: CheckpointRepo;
  private readonly chainStateRepo: ChainStateRepo;
  private readonly blockAnchorRepo: BlockAnchorRepo;

  // ERC20
  private readonly erc20TransferRepo: Erc20TransferRepo;
  private readonly erc20PartitionService: PartitionService;
  private erc20ReorgService: ReorgService | null = null;

  // NFT
  private readonly nftTransferRepo: NftTransferRepo;
  private readonly nftPartitionService: PartitionService;
  private nftReorgService: ReorgService | null = null;

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
    await Promise.all([
      this.erc20PartitionService.ensureThroughWithBuffer(safeLatest),
      this.nftPartitionService.ensureThroughWithBuffer(safeLatest),
    ]);

    await this.runErc20(safeLatest);
    await this.runNft(safeLatest);

    this.partitionTimer = setInterval(
      () => void this.runPartitionEnsureTick(), 
      this.env.PARTITION_ENSURE_INTERVAL_MS
    );
    this.reorgTimer = setInterval(
      () => void this.runReorgScanTick(),
      this.env.REORG_SCAN_INTERVAL_MS
    );

    logger.info({ safeLatest: safeLatest.toString() }, '索引器（ERC20+NFT）已启动');
  }

  async shutdown(): Promise<void> {
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

  private async runErc20(safeLatest: bigint): Promise<void> {
    const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC20');
    if (contracts.length === 0) { logger.warn('无活跃 ERC20 合约'); return; }

    const writeCoordinator = new ContractWriteCoordinator();

    const persistService = new FinalizedPersistService<TransferRecord>(
      this.pool, this.env, this.chain.http,
      this.erc20TransferRepo, this.checkpointRepo,
      this.blockAnchorRepo, this.chainStateRepo,
      this.erc20PartitionService, 'erc20',
      this.writeSemaphore,
    );

    let liveWatcher: Erc20LiveWatcher | null = null;

    const reorgService = new ReorgService(
      this.pool, this.env, this.chain.http,
      this.contractRepo, this.checkpointRepo, this.chainStateRepo, this.blockAnchorRepo,
      [this.erc20TransferRepo],
      persistService, writeCoordinator,
      {
        pauseIndexing: () => liveWatcher?.pause(),
        resumeIndexing: () => liveWatcher?.resume(),
        drainWrites: () => writeCoordinator.drain(),
      },
      'erc20',
      this.writeSemaphore,
      [new Erc20BalanceRewinder()],
    );
    this.erc20ReorgService = reorgService;

    const backfill = new Erc20BackfillService(
      this.env, this.chain.http, writeCoordinator, persistService, reorgService,
    );
    reorgService.setBackfill(backfill);

    await reorgService.scanAndRepair();

    for (const contract of contracts) {
      const stored = await this.checkpointRepo.get(contract.chainId, contract.address, 'erc20');
      const start = stored != null ? stored + 1n
        : contract.startBlock ?? (safeLatest - 100n > 0n ? safeLatest - 100n : 0n);
      if (start <= safeLatest) await backfill.fillSegmented(contract, start, safeLatest);
    }

    const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
      ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;

    liveWatcher = new Erc20LiveWatcher(
      this.env, this.chain.ws, writeCoordinator, persistService, reorgService,
      async () => {
        for (const contract of contracts) {
          const last = await this.checkpointRepo.get(contract.chainId, contract.address, 'erc20');
          const from = last != null ? last + 1n : contract.startBlock ?? 0n;
          const latest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
          if (from <= latest) await backfill.fillSegmented(contract, from, latest);
        }
      },
    );
    this.erc20LiveWatcher = liveWatcher;
    liveWatcher.start(contracts, resumeFrom);
  }

  private async runNft(safeLatest: bigint): Promise<void> {
    const contracts721 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC721');
    const contracts1155 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC1155');
    const contracts = [...contracts721, ...contracts1155];
    if (contracts.length === 0) { logger.info('无活跃 NFT 合约，跳过 NFT 索引'); return; }

    const writeCoordinator = new ContractWriteCoordinator();
    const persistService = new FinalizedPersistService<NftTransferRecord>(
      this.pool, this.env, this.chain.http,
      this.nftTransferRepo, this.checkpointRepo,
      this.blockAnchorRepo, this.chainStateRepo,
      this.nftPartitionService, 'nft',
      this.writeSemaphore,
    );

    let liveWatcher: NftLiveWatcher | null = null;
    const reorgService = new ReorgService(
      this.pool, this.env, this.chain.http,
      this.contractRepo, this.checkpointRepo, this.chainStateRepo, this.blockAnchorRepo,
      [this.nftTransferRepo],
      persistService, writeCoordinator,
      {
        pauseIndexing: () => liveWatcher?.pause(),
        resumeIndexing: () => liveWatcher?.resume(),
        drainWrites: () => writeCoordinator.drain(),
      },
      'nft',
      this.writeSemaphore,
      [new NftHoldingRewinder()],
    );
    this.nftReorgService = reorgService;

    const backfill = new NftBackfillService(
      this.env, this.chain.http, writeCoordinator, persistService, reorgService, this.nftTransferRepo,
    );
    reorgService.setBackfill(backfill);
    await reorgService.scanAndRepair();

    for (const contract of contracts) {
      const stored = await this.checkpointRepo.get(contract.chainId, contract.address, 'nft');
      const start = stored != null ? stored + 1n
        : contract.startBlock ?? (safeLatest - 100n > 0n ? safeLatest - 100n : 0n);
      if (start <= safeLatest) await backfill.fillSegmented(contract, start, safeLatest);
    }

    const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
      ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;

    liveWatcher = new NftLiveWatcher(
      this.env, this.chain.ws, writeCoordinator, persistService, reorgService,
      async () => {
        for (const contract of contracts) {
          const last = await this.checkpointRepo.get(contract.chainId, contract.address, 'nft');
          const from = last != null ? last + 1n : contract.startBlock ?? 0n;
          const latest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
          if (from <= latest) await backfill.fillSegmented(contract, from, latest);
        }
      },
    );
    this.nftLiveWatcher = liveWatcher;
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

  /** 拉取链上真正最终化块号写入 indexer_chain_state，供物化 worker 作安全上界。 */
  private async updateFinalizedBlock(): Promise<void> {
    const finalized = await getFinalizedBlockNumber(this.chain.http, this.env);
    await this.chainStateRepo.setFinalizedBlock(this.env.CHAIN_ID, finalized);
  }

  private async runReorgScanTick(): Promise<void> {
    await this.erc20ReorgService?.scanAndRepair();
    await this.nftReorgService?.scanAndRepair();
  }
}
