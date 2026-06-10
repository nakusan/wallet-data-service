import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { MATERIALIZATION_LOCK_CLASS, ZERO_ADDRESS } from '../config/constants.js';
import { CacheKeys } from '../infrastructure/cache/redis-client.js';
import { logger } from '../infrastructure/logger/logger.js';

const BATCH_BLOCKS = 5000n;

export class BalanceSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly chainId: number,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    void this.runOnce();
    logger.info({ intervalMs: this.intervalMs }, 'BalanceSyncWorker 已启动');
  }

  stop(): void {
    if (this.timer) { 
      clearInterval(this.timer); 
      this.timer = null; 
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sync();
    } catch (err) {
      logger.error({ err }, 'BalanceSyncWorker 同步失败');
    } finally {
      this.running = false;
    }
  }

  private async sync(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 与 ReorgService 回滚互斥：保证水位线读取与余额写入之间不被 reorg 穿插
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MATERIALIZATION_LOCK_CLASS,
        this.chainId,
      ]);

      // 1. 锁定并读水位线（FOR UPDATE 防止与 reorg 回滚竞争）
      const { rows: stateRows } = await client.query(
        `SELECT last_synced_block FROM balance_sync_state
         WHERE chain_id=$1 AND sync_type='erc20' FOR UPDATE`,
        [this.chainId],
      );
      const lastSynced = BigInt(stateRows[0]?.last_synced_block ?? 0);

      // 2. 上界 = LEAST(indexer 写入进度, 链上真正最终化块号)
      //    既不超前 indexer，也绝不消费可能被 reorg 的块
      const { rows: chainRows } = await client.query(
        `SELECT LEAST(min_indexed_checkpoint, finalized_block) AS safe_upper
         FROM indexer_chain_state WHERE chain_id=$1`,
        [this.chainId],
      );
      const finalized = BigInt(chainRows[0]?.safe_upper ?? 0);
      if (lastSynced >= finalized) {
        await client.query('COMMIT');
        return;
      }

      const fromBlock = lastSynced + 1n;
      const toBlock = fromBlock + BATCH_BLOCKS - 1n <= finalized ? fromBlock + BATCH_BLOCKS - 1n : finalized;

      await client.query(
        `WITH delta AS (
           SELECT chain_id, contract_address, to_address AS holder,
                  SUM(amount_raw::NUMERIC) AS d
           FROM token_transfers
           WHERE chain_id=$1 AND status='indexed'
             AND block_number BETWEEN $2 AND $3 AND to_address<>$4
           GROUP BY chain_id, contract_address, to_address
           UNION ALL
           SELECT chain_id, contract_address, from_address AS holder,
                  -SUM(amount_raw::NUMERIC) AS d
           FROM token_transfers
           WHERE chain_id=$1 AND status='indexed'
             AND block_number BETWEEN $2 AND $3 AND from_address<>$4
           GROUP BY chain_id, contract_address, from_address
           UNION ALL
           SELECT chain_id, contract_address, to_address AS holder,
                  SUM(amount_raw::NUMERIC) AS d
           FROM archive.token_transfers
           WHERE chain_id=$1 AND status='indexed'
             AND block_number BETWEEN $2 AND $3 AND to_address<>$4
           GROUP BY chain_id, contract_address, to_address
           UNION ALL
           SELECT chain_id, contract_address, from_address AS holder,
                  -SUM(amount_raw::NUMERIC) AS d
           FROM archive.token_transfers
           WHERE chain_id=$1 AND status='indexed'
             AND block_number BETWEEN $2 AND $3 AND from_address<>$4
           GROUP BY chain_id, contract_address, from_address
         ),
         net AS (
           SELECT chain_id, contract_address, holder,
                  SUM(d) AS net_delta
           FROM delta GROUP BY chain_id, contract_address, holder
         )
         INSERT INTO token_balances
           (chain_id, contract_address, holder_address,
            symbol, decimals, balance_raw, balance, last_transfer_block)
         SELECT n.chain_id, n.contract_address, n.holder,
                mc.symbol, mc.decimals,
                n.net_delta,
                n.net_delta / POWER(10, mc.decimals),
                $3
         FROM net n
         JOIN monitored_contracts mc
           ON mc.chain_id=n.chain_id AND mc.address=n.contract_address
         ON CONFLICT (chain_id, contract_address, holder_address) DO UPDATE
           SET balance_raw = token_balances.balance_raw + EXCLUDED.balance_raw,
               balance = token_balances.balance + EXCLUDED.balance,
               last_transfer_block = EXCLUDED.last_transfer_block,
               updated_at = NOW()`,
        [this.chainId, fromBlock.toString(), toBlock.toString(), ZERO_ADDRESS],
      );

      await client.query(
        `UPDATE balance_sync_state
         SET last_synced_block=$1, updated_at=NOW()
         WHERE chain_id=$2 AND sync_type='erc20'`,
        [toBlock.toString(), this.chainId],
      );

      await client.query('COMMIT');
      logger.debug({ from: fromBlock.toString(), to: toBlock.toString() }, 'ERC20 余额同步完成');

      // 4. 批量失效受影响地址的 Redis 缓存（扫描受影响的 holder_address）
      await this.invalidateAffectedCache(fromBlock, toBlock);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async invalidateAffectedCache(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT from_address AS addr FROM token_transfers
         WHERE chain_id=$1 AND status='indexed' AND block_number BETWEEN $2 AND $3
         UNION
         SELECT DISTINCT to_address FROM token_transfers
         WHERE chain_id=$1 AND status='indexed' AND block_number BETWEEN $2 AND $3
         LIMIT 500`,
        [this.chainId, fromBlock.toString(), toBlock.toString()],
      );
      const keys = rows.map((r: { addr: string }) => CacheKeys.tokenBalances(this.chainId, r.addr));
      if (keys.length > 0) await this.redis.del(...keys);
    } catch {
      // 缓存失效失败不影响主流程
    }
  }
}
