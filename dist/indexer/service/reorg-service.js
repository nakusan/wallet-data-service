import { MATERIALIZATION_LOCK_CLASS } from '../../config/constants.js';
import { BlockReader } from '../chain/block-reader.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
export class ReorgService {
    pool;
    env;
    httpClient;
    contractRepo;
    checkpointRepo;
    chainStateRepo;
    blockAnchorRepo;
    repos;
    persistService;
    writeCoordinator;
    hooks;
    indexerType;
    writeSemaphore;
    rewinders;
    blockReader;
    handling = false;
    backfill = null;
    constructor(pool, env, httpClient, contractRepo, checkpointRepo, chainStateRepo, blockAnchorRepo, repos, persistService, writeCoordinator, hooks, indexerType, writeSemaphore, rewinders = []) {
        this.pool = pool;
        this.env = env;
        this.httpClient = httpClient;
        this.contractRepo = contractRepo;
        this.checkpointRepo = checkpointRepo;
        this.chainStateRepo = chainStateRepo;
        this.blockAnchorRepo = blockAnchorRepo;
        this.repos = repos;
        this.persistService = persistService;
        this.writeCoordinator = writeCoordinator;
        this.hooks = hooks;
        this.indexerType = indexerType;
        this.writeSemaphore = writeSemaphore;
        this.rewinders = rewinders;
        this.blockReader = new BlockReader(this.httpClient);
    }
    setBackfill(backfill) {
        this.backfill = backfill;
    }
    async scanAndRepair() {
        if (this.handling)
            return;
        await this.chainStateRepo.syncFromContractMinOnPool(this.env.CHAIN_ID);
        const chainState = await this.chainStateRepo.get(this.env.CHAIN_ID);
        const scanHigh = chainState.minIndexedCheckpoint;
        if (scanHigh <= 0n)
            return;
        const ancestor = await this.detectFork(this.env.CHAIN_ID, scanHigh);
        if (ancestor == null)
            return;
        const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID);
        await this.handleReorg(contracts, ancestor);
    }
    async onReorgDetected(error) {
        const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID);
        await this.handleReorg(contracts, error.commonAncestor);
    }
    async detectFork(chainId, highBlock) {
        const depth = BigInt(this.env.REORG_SCAN_DEPTH);
        const from = highBlock - depth >= 0n ? highBlock - depth : 0n;
        for (let n = highBlock; n >= from; n--) {
            const stored = await this.blockAnchorRepo.get(chainId, n);
            if (!stored)
                continue;
            const header = await this.blockReader.getHeader(n);
            if (stored.blockHash.toLowerCase() !== header.hash.toLowerCase()) {
                const commonAncestor = await this.persistService.findCommonAncestorBelow(chainId, n);
                logger.warn({ forkBlock: n.toString(), commonAncestor: commonAncestor.toString() }, 'reorg_detected');
                return commonAncestor;
            }
        }
        return null;
    }
    async handleReorg(contracts, commonAncestor) {
        if (this.handling)
            return;
        this.handling = true;
        try {
            await this.writeCoordinator.enqueueAndWait('__reorg__', async () => {
                this.hooks.pauseIndexing();
                await this.hooks.drainWrites();
                const ancestorHash = await this.resolveAncestorHash(this.env.CHAIN_ID, commonAncestor);
                const releaseSem = await this.writeSemaphore.acquire();
                const client = await this.pool.connect();
                try {
                    await client.query('BEGIN');
                    // 与 SyncWorker 互斥：避免 reorg 回滚与物化同步交错读到半成品状态
                    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
                        MATERIALIZATION_LOCK_CLASS,
                        this.env.CHAIN_ID,
                    ]);
                    for (const contract of contracts) {
                        for (const repo of this.repos) {
                            await repo.markReorgedAfterBlock(client, contract.chainId, contract.address, commonAncestor);
                        }
                        await this.checkpointRepo.rewindTo(client, contract.chainId, contract.address, this.indexerType, commonAncestor, ancestorHash);
                    }
                    // 回滚物化层：回退水位线并修正受影响余额/持有快照（与事件层同事务，原子提交）
                    for (const rewinder of this.rewinders) {
                        await rewinder.rewindForReorg(client, this.env.CHAIN_ID, commonAncestor);
                    }
                    await this.blockAnchorRepo.deleteAfter(client, this.env.CHAIN_ID, commonAncestor);
                    await this.chainStateRepo.rewindTo(client, this.env.CHAIN_ID, commonAncestor, ancestorHash);
                    await client.query('COMMIT');
                    logger.warn({ commonAncestor: commonAncestor.toString() }, 'reorg_rewind_done');
                }
                catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                }
                finally {
                    client.release();
                    releaseSem();
                }
                // 确认深度上界（非链上真正 finalized），reorg 回滚后据此重填到安全高度。
                const safeUpper = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
                const backfill = this.backfill;
                if (!backfill) {
                    logger.error('BackfillService 未注入');
                    return;
                }
                for (const contract of contracts) {
                    const from = commonAncestor + 1n;
                    if (from <= safeUpper) {
                        await backfill.fillSegmented(contract, from, safeUpper);
                    }
                }
                logger.info({ commonAncestor: commonAncestor.toString() }, 'reorg_backfill_completed');
            });
        }
        finally {
            this.hooks.resumeIndexing();
            this.handling = false;
        }
    }
    async resolveAncestorHash(chainId, blockNumber) {
        const stored = await this.blockAnchorRepo.get(chainId, blockNumber);
        if (stored)
            return stored.blockHash;
        if (blockNumber === 0n)
            return null;
        const header = await this.blockReader.getHeader(blockNumber);
        return header.hash;
    }
}
//# sourceMappingURL=reorg-service.js.map