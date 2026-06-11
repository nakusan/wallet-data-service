import type { Pool } from 'pg';
import type { PublicClient } from 'viem';
import { formatEther, formatUnits } from 'viem';
import type { CacheService } from '../../infrastructure/cache/redis-client.js';
import { CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { withRetry } from '../../indexer/util/retry.js';
import type { ContractRepo } from '../../indexer/db/contract-repo.js';
import { erc20BalanceAbi } from '../chain/chain-read-abis.js';
import { NftChainVerifier } from '../chain/nft-chain-verifier.js';

export interface TokenBalance {
  contractAddress: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balance: string;
}

export interface NativeBalance {
  symbol: string;
  balanceRaw: string;
  balance: string;
}

export interface NftHolding {
  contractAddress: string;
  tokenId: string;
  tokenStandard: string;
  amount: string;
  name: string | null;
  imageUrl: string | null;
  metadataUri: string | null;
}

export class BalanceService {
  private readonly nftVerifier: NftChainVerifier;

  constructor(
    private readonly pool: Pool,
    private readonly httpClient: PublicClient,
    private readonly cache: CacheService,
    private readonly contractRepo: ContractRepo,
    private readonly chainId: number,
    private readonly nativeSymbol: string = 'ETH',
  ) {
    this.nftVerifier = new NftChainVerifier(httpClient);
  }

  /** 方案 3：对 monitored ERC20 multicall balanceOf，以 finalized 块链上状态为准。 */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    const addr = address.toLowerCase() as `0x${string}`;
    const tokens = await this.contractRepo.findActive(this.chainId, 'ERC20');
    if (tokens.length === 0) return [];

    const contracts = tokens.map((t) => ({
      address: t.address as `0x${string}`,
      abi: erc20BalanceAbi,
      functionName: 'balanceOf' as const,
      args: [addr] as const,
    }));

    const results = await withRetry(
      () => this.httpClient.multicall({ contracts, blockTag: 'finalized' }),
      { label: `erc20 balanceOf multicall ${addr}` },
    );

    const balances: TokenBalance[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const result = results[i];
      if (!result || result.status === 'failure') continue;

      const raw = result.result as bigint;
      if (raw <= 0n) continue;

      const decimals = token.decimals ?? 18;
      balances.push({
        contractAddress: token.address,
        symbol: token.symbol,
        decimals,
        balanceRaw: raw.toString(),
        balance: formatUnits(raw, decimals),
      });
    }

    return balances.sort((a, b) => {
      const diff = BigInt(b.balanceRaw) - BigInt(a.balanceRaw);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
  }

  /** 改法 A：DB 候选 + 链上 ownerOf/balanceOf 校验；不写回 DB。 */
  async getNftHoldings(
    address: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<NftHolding[]> {
    const addr = address.toLowerCase();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const { rows } = await this.pool.query(
      `SELECT contract_address, token_id, token_standard, amount, name, image_url, metadata_uri
       FROM nft_holdings
       WHERE chain_id=$1 AND owner_address=$2 AND amount>0
       ORDER BY updated_at DESC
       LIMIT $3 OFFSET $4`,
      [this.chainId, addr, limit, offset],
    );
    const candidates: NftHolding[] = rows.map((r) => ({
      contractAddress: r.contract_address,
      tokenId: r.token_id,
      tokenStandard: r.token_standard,
      amount: r.amount,
      name: r.name ?? null,
      imageUrl: r.image_url ?? null,
      metadataUri: r.metadata_uri ?? null,
    }));

    return this.nftVerifier.verifyHoldings(addr, candidates);
  }

  async getNativeBalance(address: string): Promise<NativeBalance> {
    const addr = address.toLowerCase();
    const key = CacheKeys.nativeBalance(this.chainId, addr);
    return this.cache.getOrSet(key, 15, async () => {
      const raw = await withRetry(
        () => this.httpClient.getBalance({ address: addr as `0x${string}`, blockTag: 'finalized' }),
        { label: `getBalance ${addr}` },
      );
      return {
        symbol: this.nativeSymbol,
        balanceRaw: raw.toString(),
        balance: formatEther(raw),
      };
    });
  }
}
