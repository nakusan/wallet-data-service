import type { PublicClient } from 'viem';
import { withRetry } from '../util/retry.js';

export interface BlockHeader {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: Date;
}

export class BlockReader {
  constructor(private readonly client: PublicClient) {}

  async getHeader(blockNumber: bigint): Promise<BlockHeader> {
    return withRetry(
      async () => {
        const block = await this.client.getBlock({ blockNumber });
        return {
          number: block.number,
          hash: block.hash as string,
          parentHash: block.parentHash as string,
          timestamp: new Date(Number(block.timestamp) * 1000),
        };
      },
      { label: `getBlock ${blockNumber}` },
    );
  }
}
