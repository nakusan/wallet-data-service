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
import type { PartitionService } from './partition-service.js';

export interface AncestorFinder {
  findCommonAncestorBelow(chainId: number, forkBlock: bigint): Promise<bigint>;
}

export interface TransferRepoLike<T> {
  batchUpsert(client: PoolClient, records: T[]): Promise<number>;
  markReorgedAfterBlock(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    afterBlock: bigint,
  ): Promise<number>;
}

export interface PersistBatchOptions {
  anchorFromBlock?: bigint;
  forceAdvance?: boolean;
}

export class FinalizedPersistService<T extends { blockNumber: bigint }> {
  readonly blockReader: BlockReader;

  constructor(
    private readonly pool: Pool,
    private readonly env: Env,
    private readonly httpClient: PublicClient,
    private readonly transferRepo: TransferRepoLike<T>,
    private readonly checkpointRepo: CheckpointRepo,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly chainStateRepo: ChainStateRepo,
    private readonly partitionService: PartitionService,
    private readonly indexerType: IndexerType,
  ) {
    this.blockReader = new BlockReader(httpClient);
  }

  async persistBatch(
    contract: MonitoredContract,
    records: T[],
    batchMaxBlock: bigint,
    options: PersistBatchOptions = {},
  ): Promise<number> {
    const finalized = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
    const effectiveMax = batchMaxBlock > finalized ? finalized : batchMaxBlock;

    const filtered = records.filter((r) => r.blockNumber <= finalized);
    const currentCheckpoint = await this.checkpointRepo.get(
      contract.chainId, contract.address, this.indexerType,
    );

    await this.partitionService.ensureThrough(effectiveMax);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (options.forceAdvance) {
        const anchorStart =
          options.anchorFromBlock ??
          (currentCheckpoint != null ? currentCheckpoint + 1n : effectiveMax);
        const from = anchorStart > effectiveMax ? effectiveMax : anchorStart;
        await this.writeAnchorsForRange(client, contract.chainId, from, effectiveMax);
      } else if (filtered.length > 0) {
        const blocks = [...new Set(filtered.map((r) => r.blockNumber))].sort(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        );
        for (const blockNumber of blocks) {
          await this.writeAnchorForBlock(client, contract.chainId, blockNumber);
        }
      }

      const inserted = filtered.length > 0
        ? await this.transferRepo.batchUpsert(client, filtered)
        : 0;

      const shouldAdvance = this.shouldAdvanceCheckpoint(options, currentCheckpoint, effectiveMax);
      if (shouldAdvance) {
        const hash = await this.blockAnchorRepo.getHashAt(client, contract.chainId, effectiveMax);
        await this.checkpointRepo.set(
          client, contract.chainId, contract.address, this.indexerType, effectiveMax, hash,
        );
      }

      await this.chainStateRepo.syncFromContractMin(client, contract.chainId);
      await client.query('COMMIT');

      if (records.length > filtered.length) {
        logger.debug(
          { symbol: contract.symbol, dropped: records.length - filtered.length },
          '已丢弃未确认深度的实时日志',
        );
      }
      return inserted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private shouldAdvanceCheckpoint(
    options: PersistBatchOptions,
    currentCheckpoint: bigint | null,
    effectiveMax: bigint,
  ): boolean {
    if (options.forceAdvance) return true;
    if (currentCheckpoint == null) return effectiveMax >= 0n;
    if (effectiveMax <= currentCheckpoint) return false;
    return effectiveMax === currentCheckpoint + 1n;
  }

  private async writeAnchorsForRange(
    client: PoolClient,
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    if (fromBlock > toBlock) return;
    for (let n = fromBlock; n <= toBlock; n++) {
      await this.writeAnchorForBlock(client, chainId, n);
    }
  }

  private async writeAnchorForBlock(
    client: PoolClient,
    chainId: number,
    blockNumber: bigint,
  ): Promise<void> {
    const header = await this.blockReader.getHeader(blockNumber);
    const upsert = await this.blockAnchorRepo.upsert(
      client, chainId, blockNumber, header.hash, header.parentHash,
    );

    if (upsert === 'conflict') {
      const commonAncestor = await this.findCommonAncestorBelow(chainId, blockNumber);
      throw new ReorgDetectedError(blockNumber, commonAncestor);
    }

    if (blockNumber > 0n) {
      const parentStored = await this.blockAnchorRepo.getHashAt(client, chainId, blockNumber - 1n);
      if (parentStored != null && parentStored.toLowerCase() !== header.parentHash.toLowerCase()) {
        const commonAncestor = await this.findCommonAncestorBelow(chainId, blockNumber);
        throw new ReorgDetectedError(blockNumber, commonAncestor);
      }
    }
  }

  async findCommonAncestorBelow(chainId: number, forkBlock: bigint): Promise<bigint> {
    const scanDepth = BigInt(this.env.REORG_SCAN_DEPTH);
    const from = forkBlock - scanDepth >= 0n ? forkBlock - scanDepth : 0n;
    for (let m = forkBlock - 1n; m >= from; m--) {
      const stored = await this.blockAnchorRepo.get(chainId, m);
      if (!stored) continue;
      const header = await this.blockReader.getHeader(m);
      if (stored.blockHash.toLowerCase() === header.hash.toLowerCase()) return m;
    }
    return forkBlock > 0n ? forkBlock - 1n : 0n;
  }
}
