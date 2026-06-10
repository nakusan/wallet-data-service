import { getSafeBlockNumber, getFinalizedBlockNumber } from './chain/viem-client.js';
import { Erc20BalanceRewinder, NftHoldingRewinder } from '../wallet/materialization-rewinder.js';
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
import { logger } from '../infrastructure/logger/logger.js';
export class IndexerApp {
    pool;
    env;
    chain;
    erc20LiveWatcher = null;
    nftLiveWatcher = null;
    partitionTimer = null;
    reorgTimer = null;
    contractRepo;
    checkpointRepo;
    chainStateRepo;
    blockAnchorRepo;
    // ERC20
    erc20TransferRepo;
    erc20PartitionService;
    erc20ReorgService = null;
    // NFT
    nftTransferRepo;
    nftPartitionService;
    nftReorgService = null;
    constructor(pool, env, chain) {
        this.pool = pool;
        this.env = env;
        this.chain = chain;
        this.contractRepo = new ContractRepo(pool);
        this.checkpointRepo = new CheckpointRepo(pool);
        this.chainStateRepo = new ChainStateRepo(pool);
        this.blockAnchorRepo = new BlockAnchorRepo(pool);
        this.erc20TransferRepo = new Erc20TransferRepo(pool);
        this.erc20PartitionService = new PartitionService(new PartitionRepo(pool, 'token_transfers'), BigInt(env.PARTITION_BLOCK_RANGE));
        this.nftTransferRepo = new NftTransferRepo(pool);
        this.nftPartitionService = new PartitionService(new PartitionRepo(pool, 'nft_transfers'), BigInt(env.PARTITION_BLOCK_RANGE));
    }
    async run() {
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
        this.partitionTimer = setInterval(() => void this.runPartitionEnsureTick(), this.env.PARTITION_ENSURE_INTERVAL_MS);
        this.reorgTimer = setInterval(() => void this.runReorgScanTick(), this.env.REORG_SCAN_INTERVAL_MS);
        logger.info({ safeLatest: safeLatest.toString() }, '索引器（ERC20+NFT）已启动');
    }
    async shutdown() {
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
    async runErc20(safeLatest) {
        const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC20');
        if (contracts.length === 0) {
            logger.warn('无活跃 ERC20 合约');
            return;
        }
        const writeCoordinator = new ContractWriteCoordinator();
        const persistService = new FinalizedPersistService(this.pool, this.env, this.chain.http, this.erc20TransferRepo, this.checkpointRepo, this.blockAnchorRepo, this.chainStateRepo, this.erc20PartitionService, 'erc20');
        let liveWatcher = null;
        const reorgService = new ReorgService(this.pool, this.env, this.chain.http, this.contractRepo, this.checkpointRepo, this.chainStateRepo, this.blockAnchorRepo, [this.erc20TransferRepo], persistService, writeCoordinator, {
            pauseIndexing: () => liveWatcher?.pause(),
            resumeIndexing: () => liveWatcher?.resume(),
            drainWrites: () => writeCoordinator.drain(),
        }, 'erc20', [new Erc20BalanceRewinder()]);
        this.erc20ReorgService = reorgService;
        const backfill = new Erc20BackfillService(this.env, this.chain.http, writeCoordinator, persistService, reorgService);
        reorgService.setBackfill(backfill);
        await reorgService.scanAndRepair();
        for (const contract of contracts) {
            const stored = await this.checkpointRepo.get(contract.chainId, contract.address, 'erc20');
            const start = stored != null ? stored + 1n
                : contract.startBlock ?? (safeLatest - 100n > 0n ? safeLatest - 100n : 0n);
            if (start <= safeLatest)
                await backfill.fillSegmented(contract, start, safeLatest);
        }
        const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
            ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;
        liveWatcher = new Erc20LiveWatcher(this.env, this.chain.ws, writeCoordinator, persistService, reorgService, async () => {
            for (const contract of contracts) {
                const last = await this.checkpointRepo.get(contract.chainId, contract.address, 'erc20');
                const from = last != null ? last + 1n : contract.startBlock ?? 0n;
                const latest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
                if (from <= latest)
                    await backfill.fillSegmented(contract, from, latest);
            }
        });
        this.erc20LiveWatcher = liveWatcher;
        liveWatcher.start(contracts, resumeFrom);
    }
    async runNft(safeLatest) {
        const contracts721 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC721');
        const contracts1155 = await this.contractRepo.findActive(this.env.CHAIN_ID, 'ERC1155');
        const contracts = [...contracts721, ...contracts1155];
        if (contracts.length === 0) {
            logger.info('无活跃 NFT 合约，跳过 NFT 索引');
            return;
        }
        const writeCoordinator = new ContractWriteCoordinator();
        const persistService = new FinalizedPersistService(this.pool, this.env, this.chain.http, this.nftTransferRepo, this.checkpointRepo, this.blockAnchorRepo, this.chainStateRepo, this.nftPartitionService, 'nft');
        let liveWatcher = null;
        const reorgService = new ReorgService(this.pool, this.env, this.chain.http, this.contractRepo, this.checkpointRepo, this.chainStateRepo, this.blockAnchorRepo, [this.nftTransferRepo], persistService, writeCoordinator, {
            pauseIndexing: () => liveWatcher?.pause(),
            resumeIndexing: () => liveWatcher?.resume(),
            drainWrites: () => writeCoordinator.drain(),
        }, 'nft', [new NftHoldingRewinder()]);
        this.nftReorgService = reorgService;
        const backfill = new NftBackfillService(this.env, this.chain.http, writeCoordinator, persistService, reorgService, this.nftTransferRepo);
        reorgService.setBackfill(backfill);
        await reorgService.scanAndRepair();
        for (const contract of contracts) {
            const stored = await this.checkpointRepo.get(contract.chainId, contract.address, 'nft');
            const start = stored != null ? stored + 1n
                : contract.startBlock ?? (safeLatest - 100n > 0n ? safeLatest - 100n : 0n);
            if (start <= safeLatest)
                await backfill.fillSegmented(contract, start, safeLatest);
        }
        const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
            ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;
        liveWatcher = new NftLiveWatcher(this.env, this.chain.ws, writeCoordinator, persistService, reorgService, async () => {
            for (const contract of contracts) {
                const last = await this.checkpointRepo.get(contract.chainId, contract.address, 'nft');
                const from = last != null ? last + 1n : contract.startBlock ?? 0n;
                const latest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
                if (from <= latest)
                    await backfill.fillSegmented(contract, from, latest);
            }
        });
        this.nftLiveWatcher = liveWatcher;
        liveWatcher.start(contracts, resumeFrom);
    }
    async runPartitionEnsureTick() {
        try {
            const safeLatest = await getSafeBlockNumber(this.chain.http, this.env.CONFIRMATION_DEPTH);
            await Promise.all([
                this.erc20PartitionService.ensureThroughWithBuffer(safeLatest),
                this.nftPartitionService.ensureThroughWithBuffer(safeLatest),
            ]);
            await this.updateFinalizedBlock();
        }
        catch (err) {
            logger.error({ err }, '定时预创建热分区失败');
        }
    }
    /** 拉取链上真正最终化块号写入 indexer_chain_state，供物化 worker 作安全上界。 */
    async updateFinalizedBlock() {
        const finalized = await getFinalizedBlockNumber(this.chain.http, this.env);
        await this.chainStateRepo.setFinalizedBlock(this.env.CHAIN_ID, finalized);
    }
    async runReorgScanTick() {
        await this.erc20ReorgService?.scanAndRepair();
        await this.nftReorgService?.scanAndRepair();
    }
}
//# sourceMappingURL=indexer-app.js.map