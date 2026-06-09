import type { Pool, PoolClient } from 'pg';
import { BATCH_INSERT_SIZE } from '../../config/constants.js';
import type { NativeTransferRecord } from '../domain/types.js';

export class NativeTransferRepo {
  constructor(private readonly pool: Pool) {}

  async batchUpsert(client: PoolClient, records: NativeTransferRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_INSERT_SIZE) {
      inserted += await this.upsertChunk(client, records.slice(i, i + BATCH_INSERT_SIZE));
    }
    return inserted;
  }

  private async upsertChunk(client: PoolClient, records: NativeTransferRecord[]): Promise<number> {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    records.forEach((r, idx) => {
      const base = idx * 9;
      placeholders.push(
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`,
      );
      values.push(
        r.chainId, r.txHash, r.blockNumber.toString(), r.blockTimestamp,
        r.txIndex,
        r.fromAddress.toLowerCase(), r.toAddress.toLowerCase(),
        r.valueRaw, r.valueEth,
      );
    });
    const result = await client.query(
      `INSERT INTO native_transfers
         (chain_id, tx_hash, block_number, block_timestamp, tx_index,
          from_address, to_address, value_raw, value_eth)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (chain_id, tx_hash, block_number) DO NOTHING`,
      values,
    );
    return result.rowCount ?? 0;
  }

  async markReorgedAfterBlock(
    client: PoolClient,
    chainId: number,
    _contractAddress: string,
    afterBlock: bigint,
  ): Promise<number> {
    // native 表无 contract_address 过滤，全链回滚
    const result = await client.query(
      `UPDATE native_transfers SET status='reorged'
       WHERE chain_id=$1 AND block_number>$2 AND status='indexed'`,
      [chainId, afterBlock.toString()],
    );
    return result.rowCount ?? 0;
  }
}
