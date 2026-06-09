import type { Pool, PoolClient } from 'pg';
import type { Checkpoint, IndexerType } from '../domain/types.js';

export class CheckpointRepo {
  constructor(private readonly pool: Pool) {}

  async get(
    chainId: number,
    contractAddress: string,
    indexerType: IndexerType,
  ): Promise<bigint | null> {
    const { rows } = await this.pool.query(
      `SELECT last_indexed_block FROM indexer_checkpoints
       WHERE chain_id=$1 AND contract_address=$2 AND indexer_type=$3`,
      [chainId, contractAddress.toLowerCase(), indexerType],
    );
    if (rows.length === 0) return null;
    return BigInt(rows[0].last_indexed_block);
  }

  async getMinAcrossActive(chainId: number, indexerType: IndexerType): Promise<bigint | null> {
    const { rows } = await this.pool.query(
      `SELECT MIN(c.last_indexed_block) AS min_block
       FROM indexer_checkpoints c
       INNER JOIN monitored_contracts m
         ON m.chain_id = c.chain_id AND lower(m.address) = c.contract_address
       WHERE m.chain_id=$1 AND m.is_active=true AND c.indexer_type=$2`,
      [chainId, indexerType],
    );
    const val = rows[0]?.min_block;
    return val != null ? BigInt(val) : null;
  }

  async set(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    indexerType: IndexerType,
    blockNumber: bigint,
    blockHash: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO indexer_checkpoints
         (chain_id, contract_address, indexer_type, last_indexed_block,
          last_finalized_block_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (chain_id, contract_address, indexer_type) DO UPDATE
         SET last_indexed_block       = EXCLUDED.last_indexed_block,
             last_finalized_block_hash = EXCLUDED.last_finalized_block_hash,
             updated_at               = NOW()`,
      [chainId, contractAddress.toLowerCase(), indexerType, blockNumber.toString(), blockHash],
    );
  }

  async rewindTo(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    indexerType: IndexerType,
    blockNumber: bigint,
    blockHash: string | null,
  ): Promise<void> {
    await this.set(client, chainId, contractAddress, indexerType, blockNumber, blockHash);
  }

  async listActive(chainId: number, indexerType: IndexerType): Promise<Checkpoint[]> {
    const { rows } = await this.pool.query(
      `SELECT c.chain_id, c.contract_address, c.indexer_type, c.last_indexed_block
       FROM indexer_checkpoints c
       INNER JOIN monitored_contracts m
         ON m.chain_id=c.chain_id AND lower(m.address)=c.contract_address
       WHERE m.chain_id=$1 AND m.is_active=true AND c.indexer_type=$2`,
      [chainId, indexerType],
    );
    return rows.map((r) => ({
      chainId: r.chain_id,
      contractAddress: r.contract_address,
      indexerType: r.indexer_type as IndexerType,
      lastIndexedBlock: BigInt(r.last_indexed_block),
    }));
  }
}
