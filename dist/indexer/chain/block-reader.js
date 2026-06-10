import { withRetry } from '../util/retry.js';
export class BlockReader {
    client;
    constructor(client) {
        this.client = client;
    }
    async getHeader(blockNumber) {
        return withRetry(async () => {
            const block = await this.client.getBlock({ blockNumber });
            return {
                number: block.number,
                hash: block.hash,
                parentHash: block.parentHash,
                timestamp: new Date(Number(block.timestamp) * 1000),
            };
        }, { label: `getBlock ${blockNumber}` });
    }
}
//# sourceMappingURL=block-reader.js.map