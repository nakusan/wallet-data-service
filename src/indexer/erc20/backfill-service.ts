import type { Pool } from 'pg';
import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import type { MonitoredContract, TransferRecord } from '../domain/types.js';
import { Erc20LogFetcher } from './log-fetcher.js';
import { getBlockTimestamp } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { Erc20LogParser } from './log-parser.js';
import type { ContractWriteCoordinator } from '../util/contract-write-coordinator.js';
import type { FinalizedPersistService } from '../service/finalized-persist-service.js';
import type { ReorgHandler } from '../service/chain-reorg-coordinator.js';
import type { ChainAnchorService } from '../service/chain-anchor-service.js';
import type { BlockAnchorRepo } from '../db/block-anchor-repo.js';
import type { ChainStateRepo } from '../db/chain-state-repo.js';
import type { CheckpointRepo } from '../db/checkpoint-repo.js';
import type { WriteSemaphore } from '../../infrastructure/db/write-semaphore.js';
import { advanceContractCheckpoint } from '../service/contract-checkpoint-advancer.js';

export class Erc20BackfillService {
  private readonly logFetcher: Erc20LogFetcher;
  private readonly parser = new Erc20LogParser();

  constructor(
    private readonly env: Env,
    httpClient: PublicClient,
    private readonly writeCoordinator: ContractWriteCoordinator,
    private readonly persistService: FinalizedPersistService<TransferRecord>,
    private readonly reorgHandler: ReorgHandler,
    private readonly chainAnchorService: ChainAnchorService,
    private readonly pool: Pool,
    private readonly checkpointRepo: CheckpointRepo,
    private readonly chainStateRepo: ChainStateRepo,
    private readonly blockAnchorRepo: BlockAnchorRepo,
    private readonly writeSemaphore: WriteSemaphore,
  ) {
    this.logFetcher = new Erc20LogFetcher(httpClient);
  }

  async fillSegmented(contract: MonitoredContract, fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (fromBlock > toBlock) return;
    let cursor = fromBlock;
    const step = BigInt(this.env.BACKFILL_MAX_BLOCK_RANGE);
    while (cursor <= toBlock) {
      const end = cursor + step - 1n <= toBlock ? cursor + step - 1n : toBlock;
      try {
        await this.chainAnchorService.ensureRange(contract.chainId, cursor, end);
        await this.writeCoordinator.enqueueAndWait(contract.address, () =>
          this.fill(contract, cursor, end),
        );
      } catch (error) {
        if (error instanceof ReorgDetectedError) {
        logger.warn(
          { flow: 'erc20.backfill', symbol: contract.symbol, forkBlock: error.forkBlock.toString() },
          '回填 anchor 检测到 reorg',
        );
          this.reorgHandler.onReorgDetected(error);
          return;
        }
        throw error;
      }
      cursor = end + 1n;
    }
  }

  private async fill(contract: MonitoredContract, fromBlock: bigint, toBlock: bigint): Promise<void> {
    const address = contract.address as `0x${string}`;
    logger.info(
      { flow: 'erc20.backfill', symbol: contract.symbol, from: fromBlock.toString(), to: toBlock.toString() },
      '开始回填',
    );

    const logs = await this.logFetcher.fetchWithAdaptiveRange(
      address, fromBlock, toBlock, BigInt(this.env.BACKFILL_MAX_BLOCK_RANGE),
    );

    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
    const timestampMap = new Map<string, Date | null>();
    for (const bn of uniqueBlocks) {
      timestampMap.set(bn.toString(), await getBlockTimestamp(this.logFetcher.client, bn));
    }

    const records = this.parser.parseMany(logs, contract, (bn) => timestampMap.get(bn.toString()) ?? null);
    const maxBlock = logs.reduce((max, log) => {
      if (log.blockNumber != null && log.blockNumber > max) return log.blockNumber;
      return max;
    }, toBlock);

    try {
      const inserted = await this.persistService.persistBatch(contract, records, maxBlock);
      await advanceContractCheckpoint(
        this.pool, this.writeSemaphore, this.checkpointRepo, this.chainStateRepo,
        this.blockAnchorRepo, contract, 'erc20', toBlock,
      );
      logger.info(
        {
          flow: 'erc20.backfill',
          symbol: contract.symbol,
          logs: logs.length,
          records: records.length,
          inserted,
          checkpoint: toBlock.toString(),
        },
        '回填批次完成',
      );
    } catch (error) {
      if (error instanceof ReorgDetectedError) {
        logger.warn(
          { flow: 'erc20.backfill', symbol: contract.symbol, forkBlock: error.forkBlock.toString() },
          '回填检测到 reorg',
        );
        this.reorgHandler.onReorgDetected(error);
        return;
      }
      throw error;
    }
  }
}
