import type { Pool, PoolClient } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import type { IndexerType, MonitoredContract } from '../domain/types.js';
import { BlockReader } from '../chain/block-reader.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { CheckpointRepo } from '../db/checkpoint-repo.js';
import type { ContractRepo } from '../db/contract-repo.js';
import type { ContractWriteCoordinator } from '../util/contract-write-coordinator.js';
import type { AncestorFinder } from './finalized-persist-service.js';

export interface ReorgLifecycleHooks {
  pauseIndexing: () => void;
  resumeIndexing: () => void;
  drainWrites: () => Promise<void>;
}

export interface ReorgableRepo {
  markReorgedAfterBlock(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    afterBlock: bigint,
  ): Promise<number>;
}

export interface BackfillServiceLike {
  fillSegmented(contract: MonitoredContract, fromBlock: bigint, toBlock: bigint): Promise<void>;
}

export class ReorgService {
  private readonly blockReader: BlockReader;
  private handling = false;
  private backfill: BackfillServiceLike | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly env: Env,
    private readonly httpClient: PublicClient,
    private readonly contractRepo: ContractRepo,
    private readonly checkpointRepo: CheckpointRepo,
    private readonly chainStateRepo: ChainStateRepo,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly repos: ReorgableRepo[],
    private readonly persistService: AncestorFinder,
    private readonly writeCoordinator: ContractWriteCoordinator,
    private readonly hooks: ReorgLifecycleHooks,
    private readonly indexerType: IndexerType,
  ) {
    this.blockReader = new BlockReader(this.httpClient);
  }

  setBackfill(backfill: BackfillServiceLike): void {
    this.backfill = backfill;
  }

  async scanAndRepair(): Promise<void> {
    if (this.handling) return;
    await this.chainStateRepo.syncFromContractMinOnPool(this.env.CHAIN_ID);
    const chainState = await this.chainStateRepo.get(this.env.CHAIN_ID);
    const scanHigh = chainState.lastFinalizedBlock;
    if (scanHigh <= 0n) return;

    const ancestor = await this.detectFork(this.env.CHAIN_ID, scanHigh);
    if (ancestor == null) return;

    const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID);
    await this.handleReorg(contracts, ancestor);
  }

  async onReorgDetected(error: ReorgDetectedError): Promise<void> {
    const contracts = await this.contractRepo.findActive(this.env.CHAIN_ID);
    await this.handleReorg(contracts, error.commonAncestor);
  }

  private async detectFork(chainId: number, highBlock: bigint): Promise<bigint | null> {
    const depth = BigInt(this.env.REORG_SCAN_DEPTH);
    const from = highBlock - depth >= 0n ? highBlock - depth : 0n;

    for (let n = highBlock; n >= from; n--) {
      const stored = await this.blockAnchorRepo.get(chainId, n);
      if (!stored) continue;
      const header = await this.blockReader.getHeader(n);
      if (stored.blockHash.toLowerCase() !== header.hash.toLowerCase()) {
        const commonAncestor = await this.persistService.findCommonAncestorBelow(chainId, n);
        logger.warn({ forkBlock: n.toString(), commonAncestor: commonAncestor.toString() }, 'reorg_detected');
        return commonAncestor;
      }
    }
    return null;
  }

  async handleReorg(contracts: MonitoredContract[], commonAncestor: bigint): Promise<void> {
    if (this.handling) return;
    this.handling = true;

    try {
      await this.writeCoordinator.enqueueAndWait('__reorg__', async () => {
        this.hooks.pauseIndexing();
        await this.hooks.drainWrites();

        const ancestorHash = await this.resolveAncestorHash(this.env.CHAIN_ID, commonAncestor);

        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          for (const contract of contracts) {
            for (const repo of this.repos) {
              await repo.markReorgedAfterBlock(
                client, contract.chainId, contract.address, commonAncestor,
              );
            }
            await this.checkpointRepo.rewindTo(
              client, contract.chainId, contract.address,
              this.indexerType, commonAncestor, ancestorHash,
            );
          }
          await this.blockAnchorRepo.deleteAfter(client, this.env.CHAIN_ID, commonAncestor);
          await this.chainStateRepo.rewindTo(client, this.env.CHAIN_ID, commonAncestor, ancestorHash);
          await client.query('COMMIT');
          logger.warn({ commonAncestor: commonAncestor.toString() }, 'reorg_rewind_done');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        const finalized = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
        const backfill = this.backfill;
        if (!backfill) { logger.error('BackfillService 未注入'); return; }

        for (const contract of contracts) {
          const from = commonAncestor + 1n;
          if (from <= finalized) {
            await backfill.fillSegmented(contract, from, finalized);
          }
        }
        logger.info({ commonAncestor: commonAncestor.toString() }, 'reorg_backfill_completed');
      });
    } finally {
      this.hooks.resumeIndexing();
      this.handling = false;
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
