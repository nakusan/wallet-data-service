import { logger } from '../../infrastructure/logger/logger.js';
export class PartitionService {
    partitionRepo;
    partitionBlockRange;
    writeSemaphore;
    ensureLock = Promise.resolve();
    constructor(partitionRepo, partitionBlockRange, writeSemaphore) {
        this.partitionRepo = partitionRepo;
        this.partitionBlockRange = partitionBlockRange;
        this.writeSemaphore = writeSemaphore;
    }
    async ensureThrough(blockNumber) {
        const run = this.ensureLock.then(() => this.doEnsureThrough(blockNumber));
        this.ensureLock = run.catch(() => { });
        return run;
    }
    async ensureThroughWithBuffer(blockNumber) {
        return this.ensureThrough(blockNumber + this.partitionBlockRange);
    }
    async doEnsureThrough(blockNumber) {
        const releaseSem = await this.writeSemaphore.acquire();
        try {
            const range = this.partitionBlockRange;
            let upper = (await this.partitionRepo.getMaxHotPartitionUpperBound()) ??
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
        finally {
            releaseSem();
        }
    }
    getTablePrefix() {
        // PartitionRepo 的 tableName 决定分区命名
        return this.partitionRepo.tableName ?? 'token_transfers';
    }
}
//# sourceMappingURL=partition-service.js.map