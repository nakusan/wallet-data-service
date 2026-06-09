import type { Pool } from 'pg';
import type { CacheService } from '../infrastructure/cache/redis-client.js';
import { CacheKeys } from '../infrastructure/cache/redis-client.js';

export interface HolderEntry {
  holderAddress: string;
  balanceRaw: string;
  balance: string;
  rank: number;
}

export class HoldersService {
  constructor(
    private readonly pool: Pool,
    private readonly cache: CacheService,
    private readonly chainId: number,
  ) {}

  async getTopHolders(contractAddress: string, limit: number): Promise<HolderEntry[]> {
    const contract = contractAddress.toLowerCase();
    const n = Math.min(limit, 100);
    const key = CacheKeys.topHolders(this.chainId, contract, n);

    return this.cache.getOrSet(key, 60, async () => {
      const { rows } = await this.pool.query(
        `SELECT holder_address, balance_raw, balance,
                ROW_NUMBER() OVER (ORDER BY balance_raw DESC) AS rank
         FROM token_balances
         WHERE chain_id=$1 AND contract_address=$2 AND balance_raw>0
         ORDER BY balance_raw DESC
         LIMIT $3`,
        [this.chainId, contract, n],
      );
      return rows.map((r) => ({
        holderAddress: r.holder_address,
        balanceRaw: r.balance_raw,
        balance: r.balance,
        rank: Number(r.rank),
      }));
    });
  }
}
