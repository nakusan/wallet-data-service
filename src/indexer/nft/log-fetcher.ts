import { parseAbi, type PublicClient } from 'viem';
import { ERC721_TRANSFER_ABI, ERC1155_ABI } from '../../config/constants.js';
import { withRetry } from '../util/retry.js';
import { logger } from '../../infrastructure/logger/logger.js';

const erc721Abi = parseAbi(ERC721_TRANSFER_ABI);
const erc1155Abi = parseAbi(ERC1155_ABI);

export interface RawErc721Log {
  eventName: 'Transfer';
  args: { from?: string; to?: string; tokenId?: bigint };
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  address: `0x${string}`;
}

export interface RawErc1155SingleLog {
  eventName: 'TransferSingle';
  args: { operator?: string; from?: string; to?: string; id?: bigint; value?: bigint };
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  address: `0x${string}`;
}

export interface RawErc1155BatchLog {
  eventName: 'TransferBatch';
  args: { operator?: string; from?: string; to?: string; ids?: readonly bigint[]; values?: readonly bigint[] };
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  address: `0x${string}`;
}

export type RawNftLog = RawErc721Log | RawErc1155SingleLog | RawErc1155BatchLog;

export class NftLogFetcher {
  constructor(readonly client: PublicClient) {}

  async fetchLogs(
    contractAddress: `0x${string}`,
    tokenStandard: 'ERC721' | 'ERC1155',
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RawNftLog[]> {
    if (tokenStandard === 'ERC721') {
      return withRetry(
        () =>
          this.client.getContractEvents({
            address: contractAddress,
            abi: erc721Abi,
            eventName: 'Transfer',
            fromBlock,
            toBlock,
          }) as Promise<RawErc721Log[]>,
        { label: `nft721 getLogs ${contractAddress}` },
      );
    }

    // ERC1155：TransferSingle + TransferBatch
    const [singles, batches] = await Promise.all([
      withRetry(
        () =>
          this.client.getContractEvents({
            address: contractAddress,
            abi: erc1155Abi,
            eventName: 'TransferSingle',
            fromBlock,
            toBlock,
          }) as Promise<RawErc1155SingleLog[]>,
        { label: `nft1155Single getLogs ${contractAddress}` },
      ),
      withRetry(
        () =>
          this.client.getContractEvents({
            address: contractAddress,
            abi: erc1155Abi,
            eventName: 'TransferBatch',
            fromBlock,
            toBlock,
          }) as Promise<RawErc1155BatchLog[]>,
        { label: `nft1155Batch getLogs ${contractAddress}` },
      ),
    ]);
    return [...singles, ...batches];
  }

  async fetchWithAdaptiveRange(
    contractAddress: `0x${string}`,
    tokenStandard: 'ERC721' | 'ERC1155',
    fromBlock: bigint,
    toBlock: bigint,
    maxRange: bigint,
  ): Promise<RawNftLog[]> {
    const allLogs: RawNftLog[] = [];
    let cursor = fromBlock;

    while (cursor <= toBlock) {
      const chunkEnd = cursor + maxRange - 1n <= toBlock ? cursor + maxRange - 1n : toBlock;
      try {
        const logs = await this.fetchLogs(contractAddress, tokenStandard, cursor, chunkEnd);
        allLogs.push(...logs);
        cursor = chunkEnd + 1n;
      } catch (error) {
        const range = chunkEnd - cursor + 1n;
        if (range <= 1n) {
          logger.error({ err: error, contractAddress, block: cursor.toString() }, 'NFT getLogs 失败');
          throw error;
        }
        const half = range / 2n;
        const mid = cursor + half - 1n;
        const logs = await this.fetchWithAdaptiveRange(
          contractAddress, tokenStandard, cursor, mid,
          maxRange / 2n > 0n ? maxRange / 2n : 1n,
        );
        allLogs.push(...logs);
        cursor = mid + 1n;
      }
    }
    return allLogs;
  }
}
