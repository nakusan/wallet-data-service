import { BATCH_INSERT_SIZE } from '../../config/constants.js';
export class NftTransferRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async batchUpsert(client, records) {
        if (records.length === 0)
            return 0;
        let inserted = 0;
        for (let i = 0; i < records.length; i += BATCH_INSERT_SIZE) {
            inserted += await this.upsertChunk(client, records.slice(i, i + BATCH_INSERT_SIZE));
        }
        return inserted;
    }
    async upsertChunk(client, records) {
        const values = [];
        const placeholders = [];
        records.forEach((r, idx) => {
            const base = idx * 13;
            placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`);
            values.push(r.chainId, r.contractAddress.toLowerCase(), r.tokenId.toString(), r.tokenStandard, r.txHash, r.logIndex, r.batchIndex, r.blockNumber.toString(), r.blockTimestamp, r.fromAddress.toLowerCase(), r.toAddress.toLowerCase(), r.amount.toString(), 'indexed');
        });
        const result = await client.query(`INSERT INTO nft_transfers
         (chain_id, contract_address, token_id, token_standard, tx_hash, log_index,
          batch_index, block_number, block_timestamp, from_address, to_address, amount, status)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (chain_id, tx_hash, log_index, batch_index, block_number) DO NOTHING`, values);
        return result.rowCount ?? 0;
    }
    async markReorgedAfterBlock(client, chainId, contractAddress, afterBlock) {
        const result = await client.query(`UPDATE nft_transfers SET status='reorged'
       WHERE chain_id=$1 AND contract_address=$2 AND block_number>$3 AND status='indexed'`, [chainId, contractAddress.toLowerCase(), afterBlock.toString()]);
        return result.rowCount ?? 0;
    }
}
//# sourceMappingURL=transfer-repo.js.map