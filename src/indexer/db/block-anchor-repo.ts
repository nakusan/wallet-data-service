import type { Pool, PoolClient } from 'pg';
import type { BlockAnchor } from '../domain/types.js';

export class BlockAnchorRepo {
  constructor(private readonly pool: Pool) {}

  async get(chainId: number, blockNumber: bigint): Promise<BlockAnchor | null> {
    const { rows } = await this.pool.query(
      `SELECT chain_id, block_number, block_hash, parent_hash
       FROM indexer_block_anchors WHERE chain_id=$1 AND block_number=$2`,
      [chainId, blockNumber.toString()],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      chainId: r.chain_id,
      blockNumber: BigInt(r.block_number),
      blockHash: r.block_hash,
      parentHash: r.parent_hash,
    };
  }

  async upsert(
    client: PoolClient,
    chainId: number,
    blockNumber: bigint,
    blockHash: string,
    parentHash: string,
  ): Promise<'inserted' | 'unchanged' | 'conflict'> {
    const existing = await client.query(
      `SELECT block_hash FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number=$2 FOR UPDATE`,
      [chainId, blockNumber.toString()],
    );
    if (existing.rows.length > 0) {
      const stored = existing.rows[0].block_hash as string;
      return stored.toLowerCase() === blockHash.toLowerCase() ? 'unchanged' : 'conflict';
    }
    await client.query(
      `INSERT INTO indexer_block_anchors (chain_id, block_number, block_hash, parent_hash)
       VALUES ($1,$2,$3,$4)`,
      [chainId, blockNumber.toString(), blockHash, parentHash],
    );
    return 'inserted';
  }

  async deleteAfter(client: PoolClient, chainId: number, afterBlock: bigint): Promise<void> {
    await client.query(
      `DELETE FROM indexer_block_anchors WHERE chain_id=$1 AND block_number>$2`,
      [chainId, afterBlock.toString()],
    );
  }

  async listExistingBlockNumbersInRange(
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Set<bigint>> {
    if (fromBlock > toBlock) return new Set();
    const { rows } = await this.pool.query<{ block_number: string }>(
      `SELECT block_number FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number >= $2 AND block_number <= $3`,
      [chainId, fromBlock.toString(), toBlock.toString()],
    );
    return new Set(rows.map((r) => BigInt(r.block_number)));
  }

  async isRangeComplete(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<boolean> {
    if (fromBlock > toBlock) return true;
    const expected = toBlock - fromBlock + 1n;
    const { rows } = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::bigint AS cnt FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number >= $2 AND block_number <= $3`,
      [chainId, fromBlock.toString(), toBlock.toString()],
    );
    return BigInt(rows[0]?.cnt ?? 0) === expected;
  }

  async getHashAt(
    client: Pool | PoolClient,
    chainId: number,
    blockNumber: bigint,
  ): Promise<string | null> {
    const { rows } = await client.query(
      `SELECT block_hash FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number=$2`,
      [chainId, blockNumber.toString()],
    );
    return rows.length > 0 ? (rows[0].block_hash as string) : null;
  }
}
