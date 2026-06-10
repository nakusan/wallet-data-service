export class BlockAnchorRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async get(chainId, blockNumber) {
        const { rows } = await this.pool.query(`SELECT chain_id, block_number, block_hash, parent_hash
       FROM indexer_block_anchors WHERE chain_id=$1 AND block_number=$2`, [chainId, blockNumber.toString()]);
        if (rows.length === 0)
            return null;
        const r = rows[0];
        return {
            chainId: r.chain_id,
            blockNumber: BigInt(r.block_number),
            blockHash: r.block_hash,
            parentHash: r.parent_hash,
        };
    }
    async upsert(client, chainId, blockNumber, blockHash, parentHash) {
        const existing = await client.query(`SELECT block_hash FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number=$2 FOR UPDATE`, [chainId, blockNumber.toString()]);
        if (existing.rows.length > 0) {
            const stored = existing.rows[0].block_hash;
            return stored.toLowerCase() === blockHash.toLowerCase() ? 'unchanged' : 'conflict';
        }
        await client.query(`INSERT INTO indexer_block_anchors (chain_id, block_number, block_hash, parent_hash)
       VALUES ($1,$2,$3,$4)`, [chainId, blockNumber.toString(), blockHash, parentHash]);
        return 'inserted';
    }
    async deleteAfter(client, chainId, afterBlock) {
        await client.query(`DELETE FROM indexer_block_anchors WHERE chain_id=$1 AND block_number>$2`, [chainId, afterBlock.toString()]);
    }
    async getHashAt(client, chainId, blockNumber) {
        const { rows } = await client.query(`SELECT block_hash FROM indexer_block_anchors
       WHERE chain_id=$1 AND block_number=$2`, [chainId, blockNumber.toString()]);
        return rows.length > 0 ? rows[0].block_hash : null;
    }
}
//# sourceMappingURL=block-anchor-repo.js.map