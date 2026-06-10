import { formatEther } from 'viem';
import { CacheKeys } from '../infrastructure/cache/redis-client.js';
import { withRetry } from '../indexer/util/retry.js';
export class BalanceService {
    pool;
    httpClient;
    cache;
    chainId;
    nativeSymbol;
    constructor(pool, httpClient, cache, chainId, nativeSymbol = 'ETH') {
        this.pool = pool;
        this.httpClient = httpClient;
        this.cache = cache;
        this.chainId = chainId;
        this.nativeSymbol = nativeSymbol;
    }
    async getTokenBalances(address) {
        const addr = address.toLowerCase();
        const { rows } = await this.pool.query(`SELECT contract_address, symbol, decimals, balance_raw, balance
       FROM token_balances
       WHERE chain_id=$1 AND holder_address=$2 AND balance_raw>0
       ORDER BY balance_raw DESC`, [this.chainId, addr]);
        return rows.map((r) => ({
            contractAddress: r.contract_address,
            symbol: r.symbol,
            decimals: r.decimals,
            balanceRaw: r.balance_raw,
            balance: r.balance,
        }));
    }
    async getNftHoldings(address, opts = {}) {
        const addr = address.toLowerCase();
        const limit = opts.limit ?? 50;
        const offset = opts.offset ?? 0;
        const { rows } = await this.pool.query(`SELECT contract_address, token_id, token_standard, amount, name, image_url, metadata_uri
       FROM nft_holdings
       WHERE chain_id=$1 AND owner_address=$2 AND amount>0
       ORDER BY updated_at DESC
       LIMIT $3 OFFSET $4`, [this.chainId, addr, limit, offset]);
        return rows.map((r) => ({
            contractAddress: r.contract_address,
            tokenId: r.token_id,
            tokenStandard: r.token_standard,
            amount: r.amount,
            name: r.name ?? null,
            imageUrl: r.image_url ?? null,
            metadataUri: r.metadata_uri ?? null,
        }));
    }
    async getNativeBalance(address) {
        const addr = address.toLowerCase();
        const key = CacheKeys.nativeBalance(this.chainId, addr);
        return this.cache.getOrSet(key, 15, async () => {
            const raw = await withRetry(() => this.httpClient.getBalance({ address: addr, blockTag: 'finalized' }), { label: `getBalance ${addr}` });
            return {
                symbol: this.nativeSymbol,
                balanceRaw: raw.toString(),
                balance: formatEther(raw),
            };
        });
    }
}
//# sourceMappingURL=balance-service.js.map