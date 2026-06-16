import type { Pool, PoolClient } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import type { IndexerType, MonitoredContract } from '../domain/types.js';
import { BlockReader, type BlockHeader } from '../chain/block-reader.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { WriteSemaphore } from '../../infrastructure/db/write-semaphore.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { CheckpointRepo } from '../db/checkpoint-repo.js';
import type { PartitionService } from './partition-service.js';
import { prefetchBlockHeaders } from '../util/prefetch-block-headers.js';

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
    private readonly writeSemaphore: WriteSemaphore,
  ) {
    this.blockReader = new BlockReader(httpClient);
  }

  async persistBatch(
    contract: MonitoredContract,
    records: T[],
    batchMaxBlock: bigint,
  ): Promise<number> {
    const safeUpper = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
    const effectiveMax = batchMaxBlock > safeUpper ? safeUpper : batchMaxBlock;

    const filtered = records.filter((r) => r.blockNumber <= safeUpper);
    const currentCheckpoint = await this.checkpointRepo.get(
      contract.chainId, contract.address, this.indexerType,
    );

    await this.partitionService.ensureThrough(effectiveMax);

    const inlineGapFill = this.shouldInlineGapFill(currentCheckpoint, effectiveMax);

    const anchorBlocks = this.collectAnchorBlocks(
      filtered, currentCheckpoint, effectiveMax, inlineGapFill,
    );
    const headerMap = await this.prefetchHeaders(anchorBlocks);

    const releaseSem = await this.writeSemaphore.acquire();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (inlineGapFill) {
        const from = currentCheckpoint! + 1n;
        await this.writeAnchorsFromPrefetched(client, contract.chainId, from, effectiveMax, headerMap);
        logger.debug(
          {
            symbol: contract.symbol,
            from: from.toString(),
            to: effectiveMax.toString(),
          },
          'live 内联补洞 anchor 完成',
        );
      } else if (filtered.length > 0) {
        const blocks = [...new Set(filtered.map((r) => r.blockNumber))].sort(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        );
        for (const blockNumber of blocks) {
          const header = headerMap.get(blockNumber.toString());
          if (!header) {
            throw new Error(`missing prefetched header for block ${blockNumber}`);
          }
          await this.writeAnchorFromPrefetched(client, contract.chainId, blockNumber, header);
        }
      }

      const inserted = filtered.length > 0
        ? await this.transferRepo.batchUpsert(client, filtered)
        : 0;

      const shouldAdvance = this.shouldAdvanceCheckpoint(
        currentCheckpoint, effectiveMax, inlineGapFill,
      );
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
      releaseSem();
    }
  }

  private collectAnchorBlocks(
    filtered: T[],
    currentCheckpoint: bigint | null,
    effectiveMax: bigint,
    inlineGapFill: boolean,
  ): bigint[] {
    if (inlineGapFill && currentCheckpoint != null) {
      const blocks: bigint[] = [];
      for (let n = currentCheckpoint + 1n; n <= effectiveMax; n++) {
        blocks.push(n);
      }
      return blocks;
    }
    if (filtered.length === 0) return [];
    return [...new Set(filtered.map((r) => r.blockNumber))];
  }

  /** live 小 gap：在单批 persist 内补全 checkpoint+1..effectiveMax 的 anchor 并推进。 */
  private shouldInlineGapFill(
    currentCheckpoint: bigint | null,
    effectiveMax: bigint,
  ): boolean {
    if (currentCheckpoint == null) return false;
    if (effectiveMax <= currentCheckpoint) return false;
    const gap = effectiveMax - currentCheckpoint;
    const maxGap = BigInt(this.env.MAX_INLINE_GAP_BLOCKS);
    return gap > 1n && gap <= maxGap;
  }

  private async prefetchHeaders(blockNumbers: bigint[]): Promise<Map<string, BlockHeader>> {
    return prefetchBlockHeaders(
      this.blockReader, blockNumbers, this.env.ANCHOR_PREFETCH_CONCURRENCY,
    );
  }

  private shouldAdvanceCheckpoint(
    currentCheckpoint: bigint | null,
    effectiveMax: bigint,
    inlineGapFill: boolean,
  ): boolean {
    if (inlineGapFill) return true;
    if (currentCheckpoint == null) return effectiveMax >= 0n;
    if (effectiveMax <= currentCheckpoint) return false;
    return effectiveMax === currentCheckpoint + 1n;
  }

  private async writeAnchorsFromPrefetched(
    client: PoolClient,
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
    headerMap: Map<string, BlockHeader>,
  ): Promise<void> {
    if (fromBlock > toBlock) return;
    for (let n = fromBlock; n <= toBlock; n++) {
      const header = headerMap.get(n.toString());
      if (!header) {
        throw new Error(`missing prefetched header for block ${n}`);
      }
      await this.writeAnchorFromPrefetched(client, chainId, n, header);
    }
  }

  private async writeAnchorFromPrefetched(
    client: PoolClient,
    chainId: number,
    blockNumber: bigint,
    header: BlockHeader,
  ): Promise<void> {
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
