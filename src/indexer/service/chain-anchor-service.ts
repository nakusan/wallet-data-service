import type { Pool, PoolClient } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import { BlockReader, type BlockHeader } from '../chain/block-reader.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { WriteSemaphore } from '../../infrastructure/db/write-semaphore.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import { prefetchBlockHeaders } from '../util/prefetch-block-headers.js';

/**
 * 链级 block anchor 维护：回填前统一补全 anchor，避免各合约重复 RPC/写入。
 */
export class ChainAnchorService {
  private readonly blockReader: BlockReader;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly pool: Pool,
    private readonly env: Env,
    httpClient: PublicClient,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly writeSemaphore: WriteSemaphore,
  ) {
    this.blockReader = new BlockReader(httpClient);
  }

  async ensureSegmented(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (fromBlock > toBlock) return;
    const step = BigInt(this.env.BACKFILL_MAX_BLOCK_RANGE);
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const end = cursor + step - 1n <= toBlock ? cursor + step - 1n : toBlock;
      await this.ensureRange(chainId, cursor, end);
      cursor = end + 1n;
    }
  }

  async ensureRange(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (fromBlock > toBlock) return;

    const key = `${chainId}:${fromBlock}:${toBlock}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      await existing;
      return;
    }

    const work = this.doEnsureRange(chainId, fromBlock, toBlock).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    await work;
  }

  private async doEnsureRange(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (await this.blockAnchorRepo.isRangeComplete(chainId, fromBlock, toBlock)) {
      return;
    }

    const missingBlocks = await this.collectMissingBlocks(chainId, fromBlock, toBlock);
    if (missingBlocks.length === 0) {
      return;
    }

    const headerMap = await prefetchBlockHeaders(
      this.blockReader,
      missingBlocks,
      this.env.ANCHOR_PREFETCH_CONCURRENCY,
    );

    const releaseSem = await this.writeSemaphore.acquire();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.writeAnchorsForBlocks(client, chainId, missingBlocks, headerMap);
      await client.query('COMMIT');
      logger.info(
        {
          flow: 'anchor',
          chainId,
          from: fromBlock.toString(),
          to: toBlock.toString(),
          fetched: missingBlocks.length,
        },
        '链级 anchor 补全完成',
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      releaseSem();
    }
  }

  private async collectMissingBlocks(
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<bigint[]> {
    const existing = await this.blockAnchorRepo.listExistingBlockNumbersInRange(
      chainId, fromBlock, toBlock,
    );
    const missing: bigint[] = [];
    for (let n = fromBlock; n <= toBlock; n++) {
      if (!existing.has(n)) missing.push(n);
    }
    return missing;
  }

  private async writeAnchorsForBlocks(
    client: PoolClient,
    chainId: number,
    blockNumbers: bigint[],
    headerMap: Map<string, BlockHeader>,
  ): Promise<void> {
    for (const n of blockNumbers) {
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

  private async findCommonAncestorBelow(chainId: number, forkBlock: bigint): Promise<bigint> {
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
