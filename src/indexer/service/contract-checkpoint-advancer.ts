import type { Pool } from 'pg';
import type { IndexerType, MonitoredContract } from '../domain/types.js';
import type { WriteSemaphore } from '../../infrastructure/db/write-semaphore.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { CheckpointRepo } from '../db/checkpoint-repo.js';

/** 链级 anchor 已就绪后，将合约 checkpoint 推进至指定块高。 */
export async function advanceContractCheckpoint(
  pool: Pool,
  writeSemaphore: WriteSemaphore,
  checkpointRepo: CheckpointRepo,
  chainStateRepo: ChainStateRepo,
  blockAnchorRepo: BlockAnchorRepo,
  contract: MonitoredContract,
  indexerType: IndexerType,
  blockNumber: bigint,
): Promise<void> {
  const releaseSem = await writeSemaphore.acquire();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await blockAnchorRepo.getHashAt(client, contract.chainId, blockNumber);
    if (hash == null) {
      throw new Error(`missing anchor at block ${blockNumber} for checkpoint advance`);
    }
    await checkpointRepo.set(
      client, contract.chainId, contract.address, indexerType, blockNumber, hash,
    );
    await chainStateRepo.syncFromContractMin(client, contract.chainId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    releaseSem();
  }
}
