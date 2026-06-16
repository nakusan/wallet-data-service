import { MATERIALIZATION_LOCK_CLASS, ZERO_ADDRESS } from '../../config/constants.js';
import { CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { BalanceSyncStateRepo } from './balance-sync-state-repo.js';
const BATCH_BLOCKS = 5000n;
const MAX_CONTRACTS_PER_TICK = 10;
export class BalanceSyncWorker {
    pool;
    redis;
    chainId;
    intervalMs;
    writeSemaphore;
    timer = null;
    running = false;
    syncStateRepo = new BalanceSyncStateRepo();
    constructor(pool, redis, chainId, intervalMs, writeSemaphore) {
        this.pool = pool;
        this.redis = redis;
        this.chainId = chainId;
        this.intervalMs = intervalMs;
        this.writeSemaphore = writeSemaphore;
    }
    start() {
        this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
        void this.runOnce();
        logger.info({ intervalMs: this.intervalMs }, 'BalanceSyncWorker 已启动');
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async runOnce() {
        if (this.running)
            return;
        this.running = true;
        try {
            await this.sync();
        }
        catch (err) {
            logger.error({ err }, 'BalanceSyncWorker 同步失败');
        }
        finally {
            this.running = false;
        }
    }
    async sync() {
        const lagging = await this.loadWorkQueue();
        if (lagging.length === 0)
            return;
        const cacheRanges = [];
        for (const item of lagging) {
            const range = await this.syncOneContract(item);
            if (range)
                cacheRanges.push(range);
        }
        for (const { contractAddress, fromBlock, toBlock } of cacheRanges) {
            logger.debug({ contract: contractAddress, from: fromBlock.toString(), to: toBlock.toString() }, 'ERC20 余额同步完成');
            await this.invalidateAffectedCache(contractAddress, fromBlock, toBlock);
        }
    }
    async loadWorkQueue() {
        const client = await this.pool.connect();
        try {
            return await this.syncStateRepo.pickLaggingErc20(client, this.chainId, MAX_CONTRACTS_PER_TICK);
        }
        finally {
            client.release();
        }
    }
    async syncOneContract({ contractAddress, lastSynced, safeUpper }) {
        const fromBlock = lastSynced + 1n;
        if (fromBlock > safeUpper)
            return null;
        const toBlock = fromBlock + BATCH_BLOCKS - 1n <= safeUpper
            ? fromBlock + BATCH_BLOCKS - 1n
            : safeUpper;
        const releaseSem = await this.writeSemaphore.acquire();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
                MATERIALIZATION_LOCK_CLASS,
                this.chainId,
            ]);
            await client.query(`WITH delta AS (
           SELECT chain_id, contract_address, to_address AS holder,
                  SUM(amount_raw::NUMERIC) AS d
           FROM token_transfers
           WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
             AND block_number BETWEEN $3 AND $4 AND to_address<>$5
           GROUP BY chain_id, contract_address, to_address
           UNION ALL
           SELECT chain_id, contract_address, from_address AS holder,
                  -SUM(amount_raw::NUMERIC) AS d
           FROM token_transfers
           WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
             AND block_number BETWEEN $3 AND $4 AND from_address<>$5
           GROUP BY chain_id, contract_address, from_address
           UNION ALL
           SELECT chain_id, contract_address, to_address AS holder,
                  SUM(amount_raw::NUMERIC) AS d
           FROM archive.token_transfers
           WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
             AND block_number BETWEEN $3 AND $4 AND to_address<>$5
           GROUP BY chain_id, contract_address, to_address
           UNION ALL
           SELECT chain_id, contract_address, from_address AS holder,
                  -SUM(amount_raw::NUMERIC) AS d
           FROM archive.token_transfers
           WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
             AND block_number BETWEEN $3 AND $4 AND from_address<>$5
           GROUP BY chain_id, contract_address, from_address
         ),
         net AS (
           SELECT chain_id, contract_address, holder,
                  SUM(d) AS net_delta
           FROM delta GROUP BY chain_id, contract_address, holder
         )
         INSERT INTO token_balances
           (chain_id, contract_address, holder_address,
            symbol, decimals, balance_raw, last_transfer_block)
         SELECT n.chain_id, n.contract_address, n.holder,
                mc.symbol, mc.decimals,
                n.net_delta,
                $4
         FROM net n
         JOIN monitored_contracts mc
           ON mc.chain_id=n.chain_id AND mc.address=n.contract_address
         ON CONFLICT (chain_id, contract_address, holder_address) DO UPDATE
           SET balance_raw = token_balances.balance_raw + EXCLUDED.balance_raw,
               last_transfer_block = EXCLUDED.last_transfer_block,
               updated_at = NOW()`, [
                this.chainId,
                contractAddress.toLowerCase(),
                fromBlock.toString(),
                toBlock.toString(),
                ZERO_ADDRESS,
            ]);
            await this.syncStateRepo.setLastSynced(client, this.chainId, contractAddress, 'erc20', toBlock);
            await client.query('COMMIT');
            return { contractAddress, fromBlock, toBlock };
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
    async invalidateAffectedCache(contractAddress, fromBlock, toBlock) {
        try {
            const { rows } = await this.pool.query(`SELECT DISTINCT from_address AS addr FROM token_transfers
         WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
           AND block_number BETWEEN $3 AND $4
         UNION
         SELECT DISTINCT to_address FROM token_transfers
         WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
           AND block_number BETWEEN $3 AND $4
         LIMIT 500`, [this.chainId, contractAddress.toLowerCase(), fromBlock.toString(), toBlock.toString()]);
            const keys = rows.map((r) => CacheKeys.tokenBalances(this.chainId, r.addr));
            if (keys.length > 0)
                await this.redis.del(...keys);
        }
        catch {
            // 缓存失效失败不影响主流程
        }
    }
}
//# sourceMappingURL=balance-sync-worker.js.map