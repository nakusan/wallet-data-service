import type { Pool, PoolClient } from 'pg';
import type Redis from 'ioredis';
import { ZERO_ADDRESS, MATERIALIZATION_LOCK_CLASS } from '../../config/constants.js';
import { CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { WriteSemaphore } from '../../infrastructure/db/write-semaphore.js';
import { BalanceSyncStateRepo, type LaggingContract } from './balance-sync-state-repo.js';

const BATCH_BLOCKS = 2000n;
const MAX_CONTRACTS_PER_TICK = 10;

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
  private readonly syncStateRepo = new BalanceSyncStateRepo();

  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly chainId: number,
    private readonly intervalMs: number,
    private readonly writeSemaphore: WriteSemaphore,
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
    const lagging = await this.loadWorkQueue();
    if (lagging.length === 0) return;

    const affectedAddrs = new Set<string>();
    let syncedCount = 0;

    for (const item of lagging) {
      const result = await this.syncOneContract(item);
      if (!result) continue;
      syncedCount += result.transferCount;
      for (const addr of result.affectedAddrs) affectedAddrs.add(addr);
    }

    if (syncedCount > 0) {
      logger.debug({ count: syncedCount }, 'NFT 持有同步批次完成');
    }

    const keys = [...affectedAddrs].map((a) => CacheKeys.nftHoldings(this.chainId, a));
    if (keys.length > 0) await this.redis.del(...keys);
  }

  private async loadWorkQueue(): Promise<LaggingContract[]> {
    const client = await this.pool.connect();
    try {
      return await this.syncStateRepo.pickLaggingNft(
        client, this.chainId, MAX_CONTRACTS_PER_TICK,
      );
    } finally {
      client.release();
    }
  }

  private async syncOneContract(
    { contractAddress, lastSynced, safeUpper }: LaggingContract,
  ): Promise<{ transferCount: number; affectedAddrs: string[] } | null> {
    const fromBlock = lastSynced + 1n;
    if (fromBlock > safeUpper) return null;

    const toBlock = fromBlock + BATCH_BLOCKS - 1n <= safeUpper
      ? fromBlock + BATCH_BLOCKS - 1n
      : safeUpper;

    const releaseSem = await this.writeSemaphore.acquire();
    const client = await this.pool.connect();
    const affectedAddrs: string[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MATERIALIZATION_LOCK_CLASS,
        this.chainId,
      ]);

      const { rows } = await client.query<NftTransferRow>(
        `SELECT contract_address, token_id, token_standard,
                from_address, to_address, amount, block_number
         FROM (
           SELECT contract_address, token_id, token_standard, from_address,
                  to_address, amount, block_number, log_index, batch_index
           FROM nft_transfers
           WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
             AND block_number BETWEEN $3 AND $4
           UNION ALL
           SELECT contract_address, token_id, token_standard, from_address,
                  to_address, amount, block_number, log_index, batch_index
           FROM archive.nft_transfers
           WHERE chain_id=$1 AND contract_address=$2 AND status='indexed'
             AND block_number BETWEEN $3 AND $4
         ) t
         ORDER BY block_number, log_index, batch_index`,
        [this.chainId, contractAddress.toLowerCase(), fromBlock.toString(), toBlock.toString()],
      );

      for (const row of rows) {
        await this.applyTransfer(client, row, toBlock);
        affectedAddrs.push(row.from_address, row.to_address);
      }

      await this.syncStateRepo.setLastSynced(
        client, this.chainId, contractAddress, 'nft', toBlock,
      );
      await client.query('COMMIT');

      logger.debug(
        { contract: contractAddress, from: fromBlock.toString(), to: toBlock.toString(), count: rows.length },
        'NFT 持有同步完成',
      );
      return { transferCount: rows.length, affectedAddrs };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      releaseSem();
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
      if (from_address !== ZERO_ADDRESS) {
        await client.query(
          `INSERT INTO nft_holdings
             (chain_id, contract_address, token_id, token_standard,
              owner_address, amount, last_transfer_block)
           VALUES ($1,$2,$3,'ERC1155',$4,-$5,$6)
           ON CONFLICT (chain_id, contract_address, token_id, owner_address)
           DO UPDATE SET amount=nft_holdings.amount-$5,
                         last_transfer_block=$6, updated_at=NOW()`,
          [
            this.chainId, contract_address, token_id, from_address,
            amountBn.toString(), blockNumber.toString(),
          ],
        );
      }
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
