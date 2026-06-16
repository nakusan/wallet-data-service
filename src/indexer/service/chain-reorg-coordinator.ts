import type { Pool } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import { BlockReader } from '../chain/block-reader.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { IndexerType } from '../domain/types.js';
import type { AncestorFinder } from './finalized-persist-service.js';
import type { ChainAnchorService } from './chain-anchor-service.js';
import type { IndexerReorgModule, LiveWatcherReorgControl } from './reorg-service.js';
import { ReorgRepairExecutor } from './reorg-service.js';

export interface ReorgHandler {
  /** 从写队列任务内调用时不得 await，以免 drain 死锁。 */
  onReorgDetected(error: ReorgDetectedError): void;
}

/**
 * 以链为单位协调 reorg：同步停止全部 watcher → 单次修复 → 全部回填 → 同步重启。
 */
export class ChainReorgCoordinator implements ReorgHandler {
  private readonly blockReader: BlockReader;
  private readonly modules = new Map<IndexerType, IndexerReorgModule>();
  private ancestorFinder: AncestorFinder | null = null;
  private handling = false;

  constructor(
    private readonly env: Env,
    private readonly httpClient: PublicClient,
    private readonly chainStateRepo: ChainStateRepo,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly chainAnchorService: ChainAnchorService,
    private readonly repairExecutor: ReorgRepairExecutor,
  ) {
    this.blockReader = new BlockReader(httpClient);
  }

  register(module: IndexerReorgModule, ancestorFinder?: AncestorFinder): void {
    this.modules.set(module.indexerType, module);
    if (ancestorFinder) {
      this.ancestorFinder = ancestorFinder;
    }
  }

  attachLiveWatcher(indexerType: IndexerType, watcher: LiveWatcherReorgControl): void {
    const module = this.modules.get(indexerType);
    if (module) {
      module.liveWatcher = watcher;
    }
  }

  onReorgDetected(error: ReorgDetectedError): void {
    queueMicrotask(() => {
      void this.handleReorg(error.commonAncestor);
    });
  }

  async scanAndRepair(): Promise<void> {
    if (this.handling) return;
    if (!this.ancestorFinder) return;

    await this.chainStateRepo.syncFromContractMinOnPool(this.env.CHAIN_ID);
    const chainState = await this.chainStateRepo.get(this.env.CHAIN_ID);
    const scanHigh = chainState.minIndexedCheckpoint;
    if (scanHigh <= 0n) return;

    const ancestor = await this.detectFork(this.env.CHAIN_ID, scanHigh);
    if (ancestor == null) return;

    await this.handleReorg(ancestor);
  }

  private async detectFork(chainId: number, highBlock: bigint): Promise<bigint | null> {
    const depth = BigInt(this.env.REORG_SCAN_DEPTH);
    const from = highBlock - depth >= 0n ? highBlock - depth : 0n;

    for (let n = highBlock; n >= from; n--) {
      const stored = await this.blockAnchorRepo.get(chainId, n);
      if (!stored) continue;
      const header = await this.blockReader.getHeader(n);
      if (stored.blockHash.toLowerCase() !== header.hash.toLowerCase()) {
        const commonAncestor = await this.ancestorFinder!.findCommonAncestorBelow(chainId, n);
        logger.warn({ forkBlock: n.toString(), commonAncestor: commonAncestor.toString() }, 'reorg_detected');
        return commonAncestor;
      }
    }
    return null;
  }

  private async handleReorg(commonAncestor: bigint): Promise<void> {
    if (this.handling) return;
    this.handling = true;

    const moduleList = [...this.modules.values()];
    try {
      for (const module of moduleList) {
        module.liveWatcher?.stopForReorg();
      }
      await Promise.all(moduleList.map((m) => m.writeCoordinator.drain()));

      await this.repairExecutor.repairChain(moduleList, commonAncestor);

      const safeUpper = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
      await Promise.all(moduleList.map((m) => this.backfillModule(m, commonAncestor, safeUpper)));

      logger.info({ commonAncestor: commonAncestor.toString() }, 'reorg_backfill_completed');

      await Promise.all(moduleList.map((m) => m.writeCoordinator.drain()));

      const resumeFrom = safeUpper - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
        ? safeUpper - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;
      for (const module of moduleList) {
        module.liveWatcher?.restartAfterReorg(resumeFrom);
      }
    } finally {
      this.handling = false;
    }
  }

  private async backfillModule(
    module: IndexerReorgModule,
    commonAncestor: bigint,
    safeUpper: bigint,
  ): Promise<void> {
    const contracts = await module.getContracts();
    const from = commonAncestor + 1n;
    if (from > safeUpper) return;

    await this.chainAnchorService.ensureSegmented(this.env.CHAIN_ID, from, safeUpper);
    await Promise.all(
      contracts.map((contract) => module.backfill.fillSegmented(contract, from, safeUpper)),
    );
  }
}

export function createChainReorgCoordinator(
  pool: Pool,
  env: Env,
  httpClient: PublicClient,
  chainStateRepo: ChainStateRepo,
  blockAnchorRepo: BlockAnchorRepo,
  chainAnchorService: ChainAnchorService,
  checkpointRepo: import('../db/checkpoint-repo.js').CheckpointRepo,
  writeSemaphore: import('../../infrastructure/db/write-semaphore.js').WriteSemaphore,
): ChainReorgCoordinator {
  const repairExecutor = new ReorgRepairExecutor(
    pool, env, httpClient, checkpointRepo, chainStateRepo, blockAnchorRepo, writeSemaphore,
  );
  return new ChainReorgCoordinator(
    env, httpClient, chainStateRepo, blockAnchorRepo, chainAnchorService, repairExecutor,
  );
}
