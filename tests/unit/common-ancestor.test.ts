import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../src/config/env.js';
import { FinalizedPersistService } from '../../src/indexer/service/finalized-persist-service.js';
import type { BlockAnchorRepo } from '../../src/indexer/db/block-anchor-repo.js';
import type { CheckpointRepo } from '../../src/indexer/db/checkpoint-repo.js';
import type { ChainStateRepo } from '../../src/indexer/db/chain-state-repo.js';
import type { PartitionService } from '../../src/indexer/service/partition-service.js';
import type { WriteSemaphore } from '../../src/infrastructure/db/write-semaphore.js';

function blockHash(n: bigint): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function createService(
  blockAnchorRepo: BlockAnchorRepo,
  getBlock: ReturnType<typeof vi.fn>,
  reorgScanDepth = 10,
): FinalizedPersistService<{ blockNumber: bigint }> {
  const env = { REORG_SCAN_DEPTH: reorgScanDepth } as Env;
  const httpClient = { getBlock } as unknown as PublicClient;

  return new FinalizedPersistService(
    {} as Pool,
    env,
    httpClient,
    { batchUpsert: vi.fn(), markReorgedAfterBlock: vi.fn() },
    {} as CheckpointRepo,
    blockAnchorRepo,
    {} as ChainStateRepo,
    {} as PartitionService,
    'erc20',
    {} as WriteSemaphore,
  );
}

describe('FinalizedPersistService.findCommonAncestorBelow', () => {
  it('返回第一个链上与本地 anchor hash 一致的块', async () => {
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: blockHash(blockNumber),
      parentHash: blockHash(blockNumber - 1n),
      timestamp: 0n,
    }));

    const blockAnchorRepo = {
      get: vi.fn(async (_chainId: number, blockNumber: bigint) => {
        if (blockNumber === 104n) {
          return { blockHash: blockHash(104n), parentHash: blockHash(103n) };
        }
        if (blockNumber === 103n) {
          return { blockHash: '0xwrong', parentHash: blockHash(102n) };
        }
        return null;
      }),
    } as unknown as BlockAnchorRepo;

    const service = createService(blockAnchorRepo, getBlock);
    const ancestor = await service.findCommonAncestorBelow(1, 105n);

    expect(ancestor).toBe(104n);
  });

  it('无匹配 anchor 时回退到 forkBlock - 1', async () => {
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: blockHash(blockNumber),
      parentHash: blockHash(blockNumber - 1n),
      timestamp: 0n,
    }));

    const blockAnchorRepo = {
      get: vi.fn(async () => null),
    } as unknown as BlockAnchorRepo;

    const service = createService(blockAnchorRepo, getBlock);
    expect(await service.findCommonAncestorBelow(1, 105n)).toBe(104n);
  });

  it('forkBlock 为 0 时返回 0', async () => {
    const getBlock = vi.fn();
    const blockAnchorRepo = { get: vi.fn(async () => null) } as unknown as BlockAnchorRepo;
    const service = createService(blockAnchorRepo, getBlock);

    expect(await service.findCommonAncestorBelow(1, 0n)).toBe(0n);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('受 REORG_SCAN_DEPTH 限制扫描下界', async () => {
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: blockHash(blockNumber),
      parentHash: blockHash(blockNumber - 1n),
      timestamp: 0n,
    }));

    const blockAnchorRepo = {
      get: vi.fn(async (_chainId: number, blockNumber: bigint) => {
        if (blockNumber === 95n) {
          return { blockHash: blockHash(95n), parentHash: blockHash(94n) };
        }
        return null;
      }),
    } as unknown as BlockAnchorRepo;

    const service = createService(blockAnchorRepo, getBlock, 5);
    // forkBlock=100, depth=5 → 扫描 99..95；95 匹配
    expect(await service.findCommonAncestorBelow(1, 100n)).toBe(95n);
  });
});
