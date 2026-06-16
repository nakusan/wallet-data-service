import { ReorgDetectedError } from '../domain/errors.js';
import { Erc20LogFetcher } from './log-fetcher.js';
import { getBlockTimestamp } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { Erc20LogParser } from './log-parser.js';
export class Erc20BackfillService {
    env;
    writeCoordinator;
    persistService;
    reorgHandler;
    logFetcher;
    parser = new Erc20LogParser();
    constructor(env, httpClient, writeCoordinator, persistService, reorgHandler) {
        this.env = env;
        this.writeCoordinator = writeCoordinator;
        this.persistService = persistService;
        this.reorgHandler = reorgHandler;
        this.logFetcher = new Erc20LogFetcher(httpClient);
    }
    async fillSegmented(contract, fromBlock, toBlock) {
        if (fromBlock > toBlock)
            return;
        let cursor = fromBlock;
        const step = BigInt(this.env.BACKFILL_MAX_BLOCK_RANGE);
        while (cursor <= toBlock) {
            const end = cursor + step - 1n <= toBlock ? cursor + step - 1n : toBlock;
            await this.writeCoordinator.enqueueAndWait(contract.address, () => this.fill(contract, cursor, end));
            cursor = end + 1n;
        }
    }
    async fill(contract, fromBlock, toBlock) {
        const address = contract.address;
        logger.info({ symbol: contract.symbol, from: fromBlock.toString(), to: toBlock.toString() }, '开始回填');
        const logs = await this.logFetcher.fetchWithAdaptiveRange(address, fromBlock, toBlock, BigInt(this.env.BACKFILL_MAX_BLOCK_RANGE));
        const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber).filter((b) => b != null))];
        const timestampMap = new Map();
        for (const bn of uniqueBlocks) {
            timestampMap.set(bn.toString(), await getBlockTimestamp(this.logFetcher.client, bn));
        }
        const records = this.parser.parseMany(logs, contract, (bn) => timestampMap.get(bn.toString()) ?? null);
        const maxBlock = logs.reduce((max, log) => {
            if (log.blockNumber != null && log.blockNumber > max)
                return log.blockNumber;
            return max;
        }, toBlock);
        try {
            const inserted = await this.persistService.persistBatch(contract, records, maxBlock, {
                anchorFromBlock: fromBlock,
                forceAdvance: true,
            });
            logger.info({ symbol: contract.symbol, logs: logs.length, inserted, checkpoint: maxBlock.toString() }, '回填批次完成');
        }
        catch (error) {
            if (error instanceof ReorgDetectedError) {
                logger.warn({ symbol: contract.symbol, forkBlock: error.forkBlock.toString() }, '回填检测到 reorg');
                this.reorgHandler.onReorgDetected(error);
                return;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=backfill-service.js.map