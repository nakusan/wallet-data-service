import type { Pool, PoolClient } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import type { IndexerType } from '../domain/types.js';
import { NativeBlockScanner } from './block-scanner.js';
import { NativeTransferRepo } from './transfer-repo.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { BlockReader } from '../chain/block-reader.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { CheckpointRepo } from '../db/checkpoint-repo.js';
import type { PartitionService } from '../service/partition-service.js';
import { NATIVE_SENTINEL_ADDRESS } from '../../config/constants.js';
import { ReorgDetectedError as ReorgErr } from '../domain/errors.js';

const INDEXER_TYPE: IndexerType = 'native';

export class NativeBackfillService {
  private readonly scanner: NativeBlockScanner;
  private readonly blockReader: BlockReader;

  constructor(
    private readonly pool: Pool,
    private readonly env: Env,
    private readonly httpClient: PublicClient,
    private readonly nativeRepo: NativeTransferRepo,
    private readonly checkpointRepo: CheckpointRepo,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly chainStateRepo: ChainStateRepo,
    private readonly partitionService: PartitionService,
  ) {
    this.scanner = new NativeBlockScanner(httpClient, env.CHAIN_ID);
    this.blockReader = new BlockReader(httpClient);
  }

  async fillRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (fromBlock > toBlock) return;

    const finalized = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
    const effectiveMax = toBlock > finalized ? finalized : toBlock;
    if (fromBlock > effectiveMax) return;

    await this.partitionService.ensureThrough(effectiveMax);

    for (let blockNumber = fromBlock; blockNumber <= effectiveMax; blockNumber++) {
      await this.processBlock(blockNumber);
    }
  }

  private async processBlock(blockNumber: bigint): Promise<void> {
    const records = await this.scanner.scanBlock(blockNumber);
    const header = await this.blockReader.getHeader(blockNumber);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 写锚点，检测 reorg
      const upsertResult = await this.blockAnchorRepo.upsert(
        client, this.env.CHAIN_ID, blockNumber, header.hash, header.parentHash,
      );

      if (upsertResult === 'conflict') {
        await client.query('ROLLBACK');
        throw new ReorgErr(blockNumber, blockNumber > 0n ? blockNumber - 1n : 0n);
      }

      if (records.length > 0) {
        await this.nativeRepo.batchUpsert(client, records);
      }

      await this.checkpointRepo.set(
        client, this.env.CHAIN_ID, NATIVE_SENTINEL_ADDRESS, INDEXER_TYPE,
        blockNumber, header.hash,
      );

      await this.chainStateRepo.syncFromContractMin(client, this.env.CHAIN_ID);
      await client.query('COMMIT');

      if (records.length > 0) {
        logger.debug({ block: blockNumber.toString(), txCount: records.length }, 'Native 区块已入库');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
