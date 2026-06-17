import { describe, it, expect } from 'vitest';
import { resolveIndexWindowStart } from '../../src/indexer/util/resolve-start-block.js';

describe('resolveIndexWindowStart', () => {
  const hotMin = 21_000_000n;

  it('start_block 为 NULL 时从 safeLatest - lookback 起算', () => {
    const start = resolveIndexWindowStart({
      startBlock: null,
      safeLatest: 21_000_200n,
      lookbackBlocks: 100n,
      hotPartitionMinBlock: hotMin,
    });
    expect(start).toBe(21_000_100n);
  });

  it('start_block 低于 lookback 下界时被抬升', () => {
    const start = resolveIndexWindowStart({
      startBlock: 100n,
      safeLatest: 21_000_200n,
      lookbackBlocks: 100n,
      hotPartitionMinBlock: hotMin,
    });
    expect(start).toBe(21_000_100n);
  });

  it('start_block 低于热层分区下界时被抬升', () => {
    const start = resolveIndexWindowStart({
      startBlock: 20_999_000n,
      safeLatest: 21_000_050n,
      lookbackBlocks: 100n,
      hotPartitionMinBlock: hotMin,
    });
    expect(start).toBe(hotMin);
  });
});
