import type { PublicClient } from 'viem';
import { erc721ReadAbi, erc1155ReadAbi } from './chain-read-abis.js';
import { withRetry } from '../../indexer/util/retry.js';
import type { NftHolding } from '../service/balance-service.js';

const VERIFY_BATCH = 50;

export class NftChainVerifier {
  constructor(private readonly httpClient: PublicClient) {}

  /** DB 候选 + 链上校验；1155 amount 以链上为准，不写回 DB。 */
  async verifyHoldings(userAddress: string, candidates: NftHolding[]): Promise<NftHolding[]> {
    if (candidates.length === 0) return [];

    const user = userAddress.toLowerCase() as `0x${string}`;
    const verified: NftHolding[] = [];

    for (let i = 0; i < candidates.length; i += VERIFY_BATCH) {
      const batch = candidates.slice(i, i + VERIFY_BATCH);
      const batchResult = await this.verifyBatch(user, batch);
      verified.push(...batchResult);
    }

    return verified;
  }

  private async verifyBatch(user: `0x${string}`, batch: NftHolding[]): Promise<NftHolding[]> {
    const contracts = batch.map((c) => {
      const tokenId = BigInt(c.tokenId);
      const address = c.contractAddress as `0x${string}`;
      if (c.tokenStandard === 'ERC721') {
        return {
          address,
          abi: erc721ReadAbi,
          functionName: 'ownerOf' as const,
          args: [tokenId] as const,
        };
      }
      return {
        address,
        abi: erc1155ReadAbi,
        functionName: 'balanceOf' as const,
        args: [user, tokenId] as const,
      };
    });

    const results = await withRetry(
      () => this.httpClient.multicall({ contracts, blockTag: 'finalized' }),
      { label: 'nft holdings multicall verify' },
    );

    const out: NftHolding[] = [];
    for (let i = 0; i < batch.length; i++) {
      const candidate = batch[i]!;
      const result = results[i];
      if (!result || result.status === 'failure') continue;

      if (candidate.tokenStandard === 'ERC721') {
        const owner = (result.result as string).toLowerCase();
        if (owner !== user) continue;
        out.push({ ...candidate, amount: '1' });
      } else {
        const amt = result.result as bigint;
        if (amt <= 0n) continue;
        out.push({ ...candidate, amount: amt.toString() });
      }
    }
    return out;
  }
}
