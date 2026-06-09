import type { Pool, PoolClient } from 'pg';
import { BATCH_INSERT_SIZE } from '../../config/constants.js';
import type { TransferRecord } from '../domain/types.js';

export class Erc20TransferRepo {
  constructor(private readonly pool: Pool) {}

  async batchUpsert(client: PoolClient, records: TransferRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_INSERT_SIZE) {
      inserted += await this.upsertChunk(client, records.slice(i, i + BATCH_INSERT_SIZE));
    }
    return inserted;
  }

  private async upsertChunk(client: PoolClient, records: TransferRecord[]): Promise<number> {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    records.forEach((r, idx) => {
      const base = idx * 11;
      placeholders.push(
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`,
      );
      values.push(
        r.chainId, r.contractAddress.toLowerCase(), r.symbol,
        r.txHash, r.logIndex, r.blockNumber.toString(),
        r.blockTimestamp, r.fromAddress.toLowerCase(), r.toAddress.toLowerCase(),
        r.amountRaw, r.amount,
      );
    });
    const result = await client.query(
      `INSERT INTO token_transfers
         (chain_id, contract_address, symbol, tx_hash, log_index, block_number,
          block_timestamp, from_address, to_address, amount_raw, amount)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (chain_id, tx_hash, log_index, block_number) DO NOTHING`,
      values,
    );
    return result.rowCount ?? 0;
  }

  async markReorgedAfterBlock(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    afterBlock: bigint,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE token_transfers SET status='reorged'
       WHERE chain_id=$1 AND contract_address=$2 AND block_number>$3 AND status='indexed'`,
      [chainId, contractAddress.toLowerCase(), afterBlock.toString()],
    );
    return result.rowCount ?? 0;
  }

  async countInPartition(partitionName: string): Promise<bigint> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::bigint AS cnt FROM public.${partitionName} WHERE status='indexed'`,
    );
    return BigInt(rows[0].cnt);
  }
}
