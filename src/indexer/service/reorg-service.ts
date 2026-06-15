import type { Pool, PoolClient } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { MATERIALIZATION_LOCK_CLASS } from '../../config/constants.js';
import type { IndexerType, MonitoredContract } from '../domain/types.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { WriteSemaphore } from '../../infrastructure/db/write-semaphore.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { CheckpointRepo } from '../db/checkpoint-repo.js';
import type { ContractWriteCoordinator } from '../util/contract-write-coordinator.js';
import { BlockReader } from '../chain/block-reader.js';

export interface ReorgableRepo {
  markReorgedAfterBlock(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    afterBlock: bigint,
  ): Promise<number>;
}

/**
 * 物化层（token_balances / nft_holdings）的 reorg 回滚器。
 * 在 reorg 修复事务内执行：回退物化水位线并修正受影响快照，保证物化层与
 * 重新回填后的事件层最终一致。实现位于 wallet 模块，按 indexerType 注入。
 */
export interface MaterializationRewinder {
  rewindForReorg(client: PoolClient, chainId: number, commonAncestor: bigint): Promise<void>;
}

export interface BackfillServiceLike {
  fillSegmented(contract: MonitoredContract, fromBlock: bigint, toBlock: bigint): Promise<void>;
}

export interface LiveWatcherReorgControl {
  stopForReorg(): void;
  restartAfterReorg(fromBlock: bigint): void;
}

export interface IndexerReorgModule {
  indexerType: IndexerType;
  writeCoordinator: ContractWriteCoordinator;
  liveWatcher: LiveWatcherReorgControl | null;
  repos: ReorgableRepo[];
  rewinders: MaterializationRewinder[];
  backfill: BackfillServiceLike;
  getContracts: () => Promise<MonitoredContract[]>;
}

/**
 * 链级 reorg 修复执行器（纯 DB 事务，无 lifecycle）。
 * 由 ChainReorgCoordinator 编排调用，在单次事务内回滚所有 indexer 模块。
 */
export class ReorgRepairExecutor {
  private readonly blockReader: BlockReader;

  constructor(
    private readonly pool: Pool,
    private readonly env: Env,
    private readonly httpClient: PublicClient,
    private readonly checkpointRepo: CheckpointRepo,
    private readonly chainStateRepo: ChainStateRepo,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly writeSemaphore: WriteSemaphore,
  ) {
    this.blockReader = new BlockReader(this.httpClient);
  }

  async repairChain(modules: IndexerReorgModule[], commonAncestor: bigint): Promise<void> {
    const chainId = this.env.CHAIN_ID;
    const ancestorHash = await this.resolveAncestorHash(chainId, commonAncestor);

    const releaseSem = await this.writeSemaphore.acquire();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MATERIALIZATION_LOCK_CLASS,
        chainId,
      ]);

      for (const module of modules) {
        const contracts = await module.getContracts();
        for (const contract of contracts) {
          for (const repo of module.repos) {
            await repo.markReorgedAfterBlock(
              client, contract.chainId, contract.address, commonAncestor,
            );
          }
          await this.checkpointRepo.rewindTo(
            client, contract.chainId, contract.address,
            module.indexerType, commonAncestor, ancestorHash,
          );
        }
        for (const rewinder of module.rewinders) {
          await rewinder.rewindForReorg(client, chainId, commonAncestor);
        }
      }

      await this.blockAnchorRepo.deleteAfter(client, chainId, commonAncestor);
      await this.chainStateRepo.rewindTo(client, chainId, commonAncestor, ancestorHash);
      await client.query('COMMIT');
      logger.warn({ commonAncestor: commonAncestor.toString() }, 'reorg_rewind_done');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      releaseSem();
    }
  }

  private async resolveAncestorHash(chainId: number, blockNumber: bigint): Promise<string | null> {
    const stored = await this.blockAnchorRepo.get(chainId, blockNumber);
    if (stored) return stored.blockHash;
    if (blockNumber === 0n) return null;
    const header = await this.blockReader.getHeader(blockNumber);
    return header.hash;
  }
}
