import { ReorgDetectedError } from '../domain/errors.js';
import { NftLogFetcher } from './log-fetcher.js';
import { NftLogParser } from './log-parser.js';
import { getBlockTimestamp } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
export class NftBackfillService {
    env;
    writeCoordinator;
    persistService;
    reorgHandler;
    nftRepo;
    logFetcher;
    parser = new NftLogParser();
    constructor(env, httpClient, writeCoordinator, persistService, reorgHandler, nftRepo) {
        this.env = env;
        this.writeCoordinator = writeCoordinator;
        this.persistService = persistService;
        this.reorgHandler = reorgHandler;
        this.nftRepo = nftRepo;
        this.logFetcher = new NftLogFetcher(httpClient);
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
        const standard = contract.tokenType;
        const address = contract.address;
        logger.info({ symbol: contract.symbol, from: fromBlock.toString(), to: toBlock.toString() }, 'NFT 开始回填');
        const logs = await this.logFetcher.fetchWithAdaptiveRange(address, standard, fromBlock, toBlock, BigInt(this.env.BACKFILL_MAX_BLOCK_RANGE));
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
            const inserted = await this.persistService.persistBatch(contract, records, maxBlock, { anchorFromBlock: fromBlock, forceAdvance: true });
            logger.info({ symbol: contract.symbol, logs: logs.length, inserted }, 'NFT 回填批次完成');
        }
        catch (error) {
            if (error instanceof ReorgDetectedError) {
                this.reorgHandler.onReorgDetected(error);
                return;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=backfill-service.js.map