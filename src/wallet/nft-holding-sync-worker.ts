import type { Pool, PoolClient } from 'pg';
import type Redis from 'ioredis';
import { ZERO_ADDRESS } from '../config/constants.js';
import { CacheKeys } from '../infrastructure/cache/redis-client.js';
import { logger } from '../infrastructure/logger/logger.js';

const BATCH_BLOCKS = 2000n;

interface NftTransferRow {
  contract_address: string;
  token_id: string;
  token_standard: string;
  from_address: string;
  to_address: string;
  amount: string;
  block_number: string;
}

export class NftHoldingSyncWorker {
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
    logger.info({ intervalMs: this.intervalMs }, 'NftHoldingSyncWorker 已启动');
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
      logger.error({ err }, 'NftHoldingSyncWorker 同步失败');
    } finally {
      this.running = false;
    }
  }

  private async sync(): Promise<void> {
    const { rows: stateRows } = await this.pool.query(
      `SELECT last_synced_block FROM balance_sync_state
       WHERE chain_id=$1 AND sync_type='nft'`,
      [this.chainId],
    );
    const lastSynced = BigInt(stateRows[0]?.last_synced_block ?? 0);

    const { rows: chainRows } = await this.pool.query(
      `SELECT last_finalized_block FROM indexer_chain_state WHERE chain_id=$1`,
      [this.chainId],
    );
    const finalized = BigInt(chainRows[0]?.last_finalized_block ?? 0);
    if (lastSynced >= finalized) return;

    const fromBlock = lastSynced + 1n;
    const toBlock = fromBlock + BATCH_BLOCKS - 1n <= finalized ? fromBlock + BATCH_BLOCKS - 1n : finalized;

    const { rows } = await this.pool.query<NftTransferRow>(
      `SELECT contract_address, token_id, token_standard,
              from_address, to_address, amount, block_number
       FROM nft_transfers
       WHERE chain_id=$1 AND status='indexed'
         AND block_number BETWEEN $2 AND $3
       ORDER BY block_number, log_index, batch_index`,
      [this.chainId, fromBlock.toString(), toBlock.toString()],
    );

    const client = await this.pool.connect();
    const affectedAddrs = new Set<string>();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await this.applyTransfer(client, row, toBlock);
        affectedAddrs.add(row.from_address);
        affectedAddrs.add(row.to_address);
      }
      await client.query(
        `UPDATE balance_sync_state
         SET last_synced_block=$1, updated_at=NOW()
         WHERE chain_id=$2 AND sync_type='nft'`,
        [toBlock.toString(), this.chainId],
      );
      await client.query('COMMIT');
      if (rows.length > 0) logger.debug({ from: fromBlock.toString(), to: toBlock.toString(), count: rows.length }, 'NFT 持有同步完成');

      const keys = [...affectedAddrs].map((a) => CacheKeys.nftHoldings(this.chainId, a));
      if (keys.length > 0) await this.redis.del(...keys);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async applyTransfer(client: PoolClient, row: NftTransferRow, blockNumber: bigint): Promise<void> {
    const { contract_address, token_id, token_standard, from_address, to_address, amount } = row;
    const amountBn = BigInt(amount);

    if (token_standard === 'ERC721') {
      if (from_address !== ZERO_ADDRESS) {
        await client.query(
          `DELETE FROM nft_holdings
           WHERE chain_id=$1 AND contract_address=$2 AND token_id=$3 AND owner_address=$4`,
          [this.chainId, contract_address, token_id, from_address],
        );
      }
      if (to_address !== ZERO_ADDRESS) {
        await client.query(
          `INSERT INTO nft_holdings
             (chain_id, contract_address, token_id, token_standard,
              owner_address, amount, last_transfer_block)
           VALUES ($1,$2,$3,'ERC721',$4,1,$5)
           ON CONFLICT (chain_id, contract_address, token_id, owner_address)
           DO UPDATE SET last_transfer_block=$5, updated_at=NOW()`,
          [this.chainId, contract_address, token_id, to_address, blockNumber.toString()],
        );
      }
    } else {
      // ERC1155: 减 from
      if (from_address !== ZERO_ADDRESS) {
        await client.query(
          `UPDATE nft_holdings
           SET amount=amount-$1, last_transfer_block=$2, updated_at=NOW()
           WHERE chain_id=$3 AND contract_address=$4
             AND token_id=$5 AND owner_address=$6`,
          [amountBn.toString(), blockNumber.toString(), this.chainId, contract_address, token_id, from_address],
        );
      }
      // 加 to
      if (to_address !== ZERO_ADDRESS) {
        await client.query(
          `INSERT INTO nft_holdings
             (chain_id, contract_address, token_id, token_standard,
              owner_address, amount, last_transfer_block)
           VALUES ($1,$2,$3,'ERC1155',$4,$5,$6)
           ON CONFLICT (chain_id, contract_address, token_id, owner_address)
           DO UPDATE SET amount=nft_holdings.amount+$5,
                         last_transfer_block=$6, updated_at=NOW()`,
          [this.chainId, contract_address, token_id, to_address, amountBn.toString(), blockNumber.toString()],
        );
      }
      // 清理零持有
      if (from_address !== ZERO_ADDRESS) {
        await client.query(
          `DELETE FROM nft_holdings
           WHERE chain_id=$1 AND contract_address=$2
             AND token_id=$3 AND owner_address=$4 AND amount<=0`,
          [this.chainId, contract_address, token_id, from_address],
        );
      }
    }
  }
}
