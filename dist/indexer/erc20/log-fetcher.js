import { parseAbi } from 'viem';
import { ERC20_TRANSFER_ABI } from '../../config/constants.js';
import { withRetry } from '../util/retry.js';
import { logger } from '../../infrastructure/logger/logger.js';
const transferAbi = parseAbi(ERC20_TRANSFER_ABI);
export class Erc20LogFetcher {
    client;
    constructor(client) {
        this.client = client;
    }
    async fetchTransferLogs(contractAddress, fromBlock, toBlock) {
        return withRetry(() => this.client.getContractEvents({
            address: contractAddress,
            abi: transferAbi,
            eventName: 'Transfer',
            fromBlock,
            toBlock,
        }), { label: `getLogs ${contractAddress} ${fromBlock}-${toBlock}` });
    }
    async fetchWithAdaptiveRange(contractAddress, fromBlock, toBlock, maxRange) {
        const allLogs = [];
        let cursor = fromBlock;
        while (cursor <= toBlock) {
            const chunkEnd = cursor + maxRange - 1n <= toBlock ? cursor + maxRange - 1n : toBlock;
            try {
                const logs = await this.fetchTransferLogs(contractAddress, cursor, chunkEnd);
                allLogs.push(...logs);
                cursor = chunkEnd + 1n;
            }
            catch (error) {
                const range = chunkEnd - cursor + 1n;
                if (range <= 1n) {
                    logger.error({ err: error, contractAddress, block: cursor.toString() }, '单块 getLogs 请求失败');
                    throw error;
                }
                const half = range / 2n;
                const mid = cursor + half - 1n;
                const logs = await this.fetchWithAdaptiveRange(contractAddress, cursor, mid, maxRange / 2n > 0n ? maxRange / 2n : 1n);
                allLogs.push(...logs);
                cursor = mid + 1n;
            }
        }
        return allLogs;
    }
}
export { transferAbi };
//# sourceMappingURL=log-fetcher.js.map