import { parseAbi, type PublicClient } from 'viem';
import { ERC20_TRANSFER_ABI } from '../../config/constants.js';
import { withRetry } from '../util/retry.js';
import { logger } from '../../infrastructure/logger/logger.js';

const transferAbi = parseAbi(ERC20_TRANSFER_ABI);

export interface RawTransferLog {
  args: { from?: string; to?: string; value?: bigint };
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  address: `0x${string}`;
}

export class Erc20LogFetcher {
  constructor(readonly client: PublicClient) {}

  async fetchTransferLogs(
    contractAddress: `0x${string}`,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RawTransferLog[]> {
    return withRetry(
      () =>
        this.client.getContractEvents({
          address: contractAddress,
          abi: transferAbi,
          eventName: 'Transfer',
          fromBlock,
          toBlock,
        }) as Promise<RawTransferLog[]>,
      { label: `getLogs ${contractAddress} ${fromBlock}-${toBlock}` },
    );
  }

  async fetchWithAdaptiveRange(
    contractAddress: `0x${string}`,
    fromBlock: bigint,
    toBlock: bigint,
    maxRange: bigint,
  ): Promise<RawTransferLog[]> {
    const allLogs: RawTransferLog[] = [];
    let cursor = fromBlock;

    while (cursor <= toBlock) {
      const chunkEnd = cursor + maxRange - 1n <= toBlock ? cursor + maxRange - 1n : toBlock;
      try {
        const logs = await this.fetchTransferLogs(contractAddress, cursor, chunkEnd);
        allLogs.push(...logs);
        cursor = chunkEnd + 1n;
      } catch (error) {
        const range = chunkEnd - cursor + 1n;
        if (range <= 1n) {
          logger.error({ err: error, contractAddress, block: cursor.toString() }, '单块 getLogs 请求失败');
          throw error;
        }
        const half = range / 2n;
        const mid = cursor + half - 1n;
        const logs = await this.fetchWithAdaptiveRange(
          contractAddress, cursor, mid, maxRange / 2n > 0n ? maxRange / 2n : 1n,
        );
        allLogs.push(...logs);
        cursor = mid + 1n;
      }
    }
    return allLogs;
  }
}

export { transferAbi };
