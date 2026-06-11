import { formatUnits } from 'viem';
import { CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { INDEXED_DATA_DISCLAIMER } from './indexing-disclaimer.js';
export class HoldersService {
    pool;
    cache;
    contractRepo;
    chainId;
    constructor(pool, cache, contractRepo, chainId) {
        this.pool = pool;
        this.cache = cache;
        this.contractRepo = contractRepo;
        this.chainId = chainId;
    }
    async getTopHolders(contractAddress, limit) {
        const contract = contractAddress.toLowerCase();
        const n = Math.min(limit, 100);
        const key = CacheKeys.topHolders(this.chainId, contract, n);
        const indexedSinceBlock = await this.contractRepo.getStartBlock(this.chainId, contract);
        const indexedSinceStr = indexedSinceBlock?.toString() ?? null;
        const data = await this.cache.getOrSet(key, 60, async () => {
            const { rows } = await this.pool.query(`SELECT holder_address, balance_raw, decimals,
                ROW_NUMBER() OVER (ORDER BY balance_raw DESC) AS rank
         FROM token_balances
         WHERE chain_id=$1 AND contract_address=$2 AND balance_raw>0
         ORDER BY balance_raw DESC
         LIMIT $3`, [this.chainId, contract, n]);
            return rows.map((r) => ({
                holderAddress: r.holder_address,
                balanceRaw: r.balance_raw,
                balance: formatUnits(BigInt(r.balance_raw), Number(r.decimals)),
                rank: Number(r.rank),
            }));
        });
        return {
            data,
            total: data.length,
            indexedSinceBlock: indexedSinceStr,
            disclaimer: INDEXED_DATA_DISCLAIMER,
        };
    }
}
//# sourceMappingURL=holders-service.js.map