import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicClient } from 'viem';
import type { Env } from '../../src/config/env.js';
import { ReorgDetectedError } from '../../src/indexer/domain/errors.js';
import { ChainReorgCoordinator } from '../../src/indexer/service/chain-reorg-coordinator.js';
import type { IndexerReorgModule } from '../../src/indexer/service/reorg-service.js';
import { ContractWriteCoordinator } from '../../src/indexer/util/contract-write-coordinator.js';
import { makeErc20Contract } from './fixtures/contracts.js';

vi.mock('../../src/indexer/chain/viem-client.js', () => ({
  getSafeBlockNumber: vi.fn(async () => 21_000_120n),
}));

function makeModule(overrides: Partial<IndexerReorgModule> = {}): IndexerReorgModule {
  const writeCoordinator = new ContractWriteCoordinator();
  return {
    indexerType: 'erc20',
    writeCoordinator,
    liveWatcher: {
      stopForReorg: vi.fn(),
      restartAfterReorg: vi.fn(),
    },
    repos: [],
    rewinders: [],
    backfill: { fillSegmented: vi.fn(async () => {}) },
    getContracts: vi.fn(async () => [makeErc20Contract()]),
    ...overrides,
  };
}

function makeCoordinator(modules: IndexerReorgModule[] = [makeModule()]) {
  const env = {
    CHAIN_ID: 1,
    CONFIRMATION_DEPTH: 12,
    BACKFILL_OVERLAP_BLOCKS: 2,
  } as Env;

  const repairExecutor = { repairChain: vi.fn(async () => {}) };
  const chainAnchorService = { ensureSegmented: vi.fn(async () => {}) };

  const coordinator = new ChainReorgCoordinator(
    env,
    {} as PublicClient,
    { syncFromContractMinOnPool: vi.fn(), get: vi.fn() } as never,
    { get: vi.fn() } as never,
    chainAnchorService as never,
    repairExecutor as never,
  );

  for (const module of modules) {
    coordinator.register(module);
  }

  return { coordinator, repairExecutor, chainAnchorService, modules, env };
}

async function flushReorg(coordinator: ChainReorgCoordinator, commonAncestor: bigint): Promise<void> {
  coordinator.onReorgDetected(new ReorgDetectedError(105n, commonAncestor));
  await vi.waitFor(() => {}, { timeout: 3000 }).catch(() => {});
  // queueMicrotask + async chain
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('ChainReorgCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('onReorgDetected 按顺序 stop → drain → repair → backfill → drain → restart', async () => {
    const order: string[] = [];
    const writeCoordinator = new ContractWriteCoordinator();
    const originalDrain = writeCoordinator.drain.bind(writeCoordinator);
    writeCoordinator.drain = vi.fn(async () => {
      order.push('drain');
      await originalDrain();
    });

    const module = makeModule({
      writeCoordinator,
      liveWatcher: {
        stopForReorg: vi.fn(() => { order.push('stop'); }),
        restartAfterReorg: vi.fn(() => { order.push('restart'); }),
      },
      backfill: {
        fillSegmented: vi.fn(async () => { order.push('backfill'); }),
      },
    });

    const { coordinator, repairExecutor } = makeCoordinator([module]);
    repairExecutor.repairChain = vi.fn(async () => { order.push('repair'); });

    await flushReorg(coordinator, 21_000_100n);

    expect(order.indexOf('stop')).toBeLessThan(order.indexOf('drain'));
    expect(order.filter((s) => s === 'drain')).toHaveLength(2);
    expect(order.indexOf('repair')).toBeGreaterThan(order.indexOf('drain'));
    expect(order.indexOf('backfill')).toBeGreaterThan(order.indexOf('repair'));
    expect(order.indexOf('restart')).toBeGreaterThan(order.lastIndexOf('drain'));
    expect(module.liveWatcher!.restartAfterReorg).toHaveBeenCalledWith(21_000_118n);
  });

  it('并发 reorg 通知在 handling 期间被忽略', async () => {
    let resolveRepair!: () => void;
    const repairGate = new Promise<void>((r) => { resolveRepair = r; });

    const module = makeModule();
    const { coordinator, repairExecutor } = makeCoordinator([module]);
    repairExecutor.repairChain = vi.fn(async () => { await repairGate; });

    coordinator.onReorgDetected(new ReorgDetectedError(105n, 100n));
    coordinator.onReorgDetected(new ReorgDetectedError(106n, 101n));
    await new Promise((r) => setTimeout(r, 0));

    expect(repairExecutor.repairChain).toHaveBeenCalledTimes(1);

    resolveRepair();
    await new Promise((r) => setTimeout(r, 50));
    expect(repairExecutor.repairChain).toHaveBeenCalledTimes(1);
  });

  it('commonAncestor 之后无安全块时不触发 backfill', async () => {
    const { getSafeBlockNumber } = await import('../../src/indexer/chain/viem-client.js');
    vi.mocked(getSafeBlockNumber).mockResolvedValueOnce(21_000_100n);

    const module = makeModule();
    const { coordinator } = makeCoordinator([module]);

    await flushReorg(coordinator, 21_000_100n);

    expect(module.backfill.fillSegmented).not.toHaveBeenCalled();
    expect(module.liveWatcher!.restartAfterReorg).toHaveBeenCalled();
  });
});
