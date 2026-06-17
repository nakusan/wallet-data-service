import { describe, it, expect } from 'vitest';
import { PartitionRepo } from '../../src/indexer/db/partition-repo.js';
import { PartitionService } from '../../src/indexer/service/partition-service.js';
import { WriteSemaphore } from '../../src/infrastructure/db/write-semaphore.js';
import { TEST_BLOCKS } from '../setup/constants.js';
import { getTestPool } from '../setup/db.js';

describe('PartitionService', () => {
  it('ensureThrough 在需要时创建新热分区', async () => {
    const pool = getTestPool();
    const repo = new PartitionRepo(pool, 'token_transfers');
    const service = new PartitionService(repo, 500_000n, new WriteSemaphore(1));

    const partitionName = 'token_transfers_p22000000_22500000';
    const existedBefore = await repo.hotPartitionExists(partitionName);
    expect(existedBefore).toBe(false);

    await service.ensureThrough(TEST_BLOCKS.newPartition);

    expect(await repo.hotPartitionExists(partitionName)).toBe(true);
  });

  it('重复调用 ensureThrough 幂等', async () => {
    const pool = getTestPool();
    const repo = new PartitionRepo(pool, 'token_transfers');
    const service = new PartitionService(repo, 500_000n, new WriteSemaphore(1));

    await service.ensureThrough(TEST_BLOCKS.newPartition);
    await expect(service.ensureThrough(TEST_BLOCKS.newPartition)).resolves.toBeUndefined();
  });

  it('并发 ensureThrough 不抛错', async () => {
    const pool = getTestPool();
    const repo = new PartitionRepo(pool, 'nft_transfers');
    const service = new PartitionService(repo, 500_000n, new WriteSemaphore(1));

    await Promise.all([
      service.ensureThrough(TEST_BLOCKS.newPartition),
      service.ensureThrough(TEST_BLOCKS.newPartition),
    ]);

    expect(await repo.hotPartitionExists('nft_transfers_p22000000_22500000')).toBe(true);
  });
});
