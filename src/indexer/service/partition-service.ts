import type { PartitionRepo } from '../db/partition-repo.js';
import { logger } from '../../infrastructure/logger/logger.js';

export class PartitionService {
  private ensureLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly partitionRepo: PartitionRepo,
    private readonly partitionBlockRange: bigint,
  ) {}

  async ensureThrough(blockNumber: bigint): Promise<void> {
    const run = this.ensureLock.then(() => this.doEnsureThrough(blockNumber));
    this.ensureLock = run.catch(() => {});
    return run;
  }

  async ensureThroughWithBuffer(blockNumber: bigint): Promise<void> {
    return this.ensureThrough(blockNumber + this.partitionBlockRange);
  }

  private async doEnsureThrough(blockNumber: bigint): Promise<void> {
    const range = this.partitionBlockRange;
    let upper =
      (await this.partitionRepo.getMaxHotPartitionUpperBound()) ??
      (blockNumber / range) * range;

    while (upper <= blockNumber) {
      const blockFrom = upper;
      const blockTo = upper + range;
      const name = `${this.getTablePrefix()}_p${blockFrom}_${blockTo}`;
      const existed = await this.partitionRepo.hotPartitionExists(name);
      await this.partitionRepo.createHotPartition(name, blockFrom, blockTo);
      if (!existed) {
        logger.info({ partition: name }, '已确保热分区存在');
      }
      upper = blockTo;
    }
  }

  private getTablePrefix(): string {
    // PartitionRepo 的 tableName 决定分区命名
    return (this.partitionRepo as unknown as { tableName: string }).tableName ?? 'token_transfers';
  }
}
