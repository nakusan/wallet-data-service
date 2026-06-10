import type { Pool, PoolClient } from 'pg';
import type { ChainState } from '../domain/types.js';

export class ChainStateRepo {
  constructor(private readonly pool: Pool) {}

  async ensureInitialized(chainId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexer_chain_state (chain_id, min_indexed_checkpoint)
       VALUES ($1, 0) ON CONFLICT (chain_id) DO NOTHING`,
      [chainId],
    );
  }

  async get(chainId: number): Promise<ChainState> {
    await this.ensureInitialized(chainId);
    const { rows } = await this.pool.query(
      `SELECT chain_id, min_indexed_checkpoint, min_indexed_checkpoint_hash, finalized_block
       FROM indexer_chain_state WHERE chain_id=$1`,
      [chainId],
    );
    const r = rows[0];
    return {
      chainId: r.chain_id,
      minIndexedCheckpoint: BigInt(r.min_indexed_checkpoint),
      minIndexedCheckpointHash: r.min_indexed_checkpoint_hash ?? null,
      finalizedBlock: BigInt(r.finalized_block ?? 0),
    };
  }

  async rewindTo(
    client: PoolClient,
    chainId: number,
    blockNumber: bigint,
    blockHash: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE indexer_chain_state
       SET min_indexed_checkpoint=$2, min_indexed_checkpoint_hash=$3, updated_at=NOW()
       WHERE chain_id=$1`,
      [chainId, blockNumber.toString(), blockHash],
    );
  }

  /** 写入链上真正最终化的块号（来自 RPC finalized 标签或回退值）。 */
  async setFinalizedBlock(chainId: number, blockNumber: bigint): Promise<void> {
    await this.ensureInitialized(chainId);
    await this.pool.query(
      `UPDATE indexer_chain_state
       SET finalized_block=GREATEST(finalized_block, $2), updated_at=NOW()
       WHERE chain_id=$1`,
      [chainId, blockNumber.toString()],
    );
  }

  async syncFromContractMinOnPool(chainId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.syncFromContractMin(client, chainId);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async syncFromContractMin(client: PoolClient, chainId: number): Promise<void> {
    const { rows } = await client.query(
      `SELECT MIN(c.last_indexed_block) AS min_block
       FROM indexer_checkpoints c
       INNER JOIN monitored_contracts m
         ON m.chain_id=c.chain_id AND lower(m.address)=c.contract_address
       WHERE m.chain_id=$1 AND m.is_active=true`,
      [chainId],
    );
    const minBlock = rows[0]?.min_block;
    if (minBlock == null) return;

    const hash = await client.query(
      `SELECT block_hash FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number=$2`,
      [chainId, minBlock],
    );

    await client.query(
      `UPDATE indexer_chain_state
       SET min_indexed_checkpoint=$2, min_indexed_checkpoint_hash=$3, updated_at=NOW()
       WHERE chain_id=$1`,
      [chainId, minBlock, hash.rows[0]?.block_hash ?? null],
    );
  }
}
