import { MATERIALIZATION_LOCK_CLASS } from '../../config/constants.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { BlockReader } from '../chain/block-reader.js';
/**
 * 链级 reorg 修复执行器（纯 DB 事务，无 lifecycle）。
 * 由 ChainReorgCoordinator 编排调用，在单次事务内回滚所有 indexer 模块。
 */
export class ReorgRepairExecutor {
    pool;
    env;
    httpClient;
    checkpointRepo;
    chainStateRepo;
    blockAnchorRepo;
    writeSemaphore;
    blockReader;
    constructor(pool, env, httpClient, checkpointRepo, chainStateRepo, blockAnchorRepo, writeSemaphore) {
        this.pool = pool;
        this.env = env;
        this.httpClient = httpClient;
        this.checkpointRepo = checkpointRepo;
        this.chainStateRepo = chainStateRepo;
        this.blockAnchorRepo = blockAnchorRepo;
        this.writeSemaphore = writeSemaphore;
        this.blockReader = new BlockReader(this.httpClient);
    }
    async repairChain(modules, commonAncestor) {
        const chainId = this.env.CHAIN_ID;
        const ancestorHash = await this.resolveAncestorHash(chainId, commonAncestor);
        const releaseSem = await this.writeSemaphore.acquire();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
                MATERIALIZATION_LOCK_CLASS,
                chainId,
            ]);
            for (const module of modules) {
                const contracts = await module.getContracts();
                for (const contract of contracts) {
                    for (const repo of module.repos) {
                        await repo.markReorgedAfterBlock(client, contract.chainId, contract.address, commonAncestor);
                    }
                    await this.checkpointRepo.rewindTo(client, contract.chainId, contract.address, module.indexerType, commonAncestor, ancestorHash);
                }
                for (const rewinder of module.rewinders) {
                    await rewinder.rewindForReorg(client, chainId, commonAncestor);
                }
            }
            await this.blockAnchorRepo.deleteAfter(client, chainId, commonAncestor);
            await this.chainStateRepo.rewindTo(client, chainId, commonAncestor, ancestorHash);
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