import { INDEXED_DATA_DISCLAIMER } from './indexing-disclaimer.js';
function encodeCursor(c) {
    return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(s) {
    return JSON.parse(Buffer.from(s, 'base64url').toString());
}
export class TxHistoryService {
    pool;
    contractRepo;
    constructor(pool, contractRepo) {
        this.pool = pool;
        this.contractRepo = contractRepo;
    }
    async getHistory(chainId, address, opts = {}) {
        const addr = address.toLowerCase();
        const limit = Math.min(opts.limit ?? 20, 100);
        const token = opts.token?.toLowerCase() ?? null;
        const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
        const indexedSinceBlock = token != null
            ? await this.contractRepo.getStartBlock(chainId, token)
            : await this.contractRepo.getMinErc20StartBlock(chainId);
        const { rows } = await this.pool.query(`SELECT chain_id, contract_address, symbol, tx_hash, log_index,
              block_number::TEXT, block_timestamp, from_address, to_address,
              amount, amount_raw,
              CASE WHEN to_address=$1 THEN 'in' ELSE 'out' END AS direction
       FROM (
         SELECT * FROM token_transfers
         WHERE chain_id=$2 AND status='indexed'
           AND (from_address=$1 OR to_address=$1)
           AND ($3::varchar IS NULL OR contract_address=$3)
           AND ($4::bigint IS NULL OR
                (block_number, log_index) < ($4::bigint, $5::int))
         UNION ALL
         SELECT * FROM archive.token_transfers
         WHERE chain_id=$2 AND status='indexed'
           AND (from_address=$1 OR to_address=$1)
           AND ($3::varchar IS NULL OR contract_address=$3)
           AND ($4::bigint IS NULL OR
                (block_number, log_index) < ($4::bigint, $5::int))
       ) combined
       ORDER BY block_number DESC, log_index DESC
       LIMIT $6`, [
            addr, chainId, token,
            cursor?.blockNumber ?? null,
            cursor?.logIndex ?? null,
            limit + 1,
        ]);
        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;
        const last = data[data.length - 1];
        return {
            data: data,
            nextCursor: hasMore && last
                ? encodeCursor({ blockNumber: last.block_number, logIndex: last.log_index })
                : null,
            hasMore,
            indexedSinceBlock: indexedSinceBlock?.toString() ?? null,
            disclaimer: INDEXED_DATA_DISCLAIMER,
        };
    }
}
//# sourceMappingURL=tx-history-service.js.map