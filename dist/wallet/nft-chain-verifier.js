import { erc721ReadAbi, erc1155ReadAbi } from './chain-read-abis.js';
import { withRetry } from '../indexer/util/retry.js';
const VERIFY_BATCH = 50;
export class NftChainVerifier {
    httpClient;
    constructor(httpClient) {
        this.httpClient = httpClient;
    }
    /** DB 候选 + 链上校验；1155 amount 以链上为准，不写回 DB。 */
    async verifyHoldings(userAddress, candidates) {
        if (candidates.length === 0)
            return [];
        const user = userAddress.toLowerCase();
        const verified = [];
        for (let i = 0; i < candidates.length; i += VERIFY_BATCH) {
            const batch = candidates.slice(i, i + VERIFY_BATCH);
            const batchResult = await this.verifyBatch(user, batch);
            verified.push(...batchResult);
        }
        return verified;
    }
    async verifyBatch(user, batch) {
        const contracts = batch.map((c) => {
            const tokenId = BigInt(c.tokenId);
            const address = c.contractAddress;
            if (c.tokenStandard === 'ERC721') {
                return {
                    address,
                    abi: erc721ReadAbi,
                    functionName: 'ownerOf',
                    args: [tokenId],
                };
            }
            return {
                address,
                abi: erc1155ReadAbi,
                functionName: 'balanceOf',
                args: [user, tokenId],
            };
        });
        const results = await withRetry(() => this.httpClient.multicall({ contracts, blockTag: 'finalized' }), { label: 'nft holdings multicall verify' });
        const out = [];
        for (let i = 0; i < batch.length; i++) {
            const candidate = batch[i];
            const result = results[i];
            if (!result || result.status === 'failure')
                continue;
            if (candidate.tokenStandard === 'ERC721') {
                const owner = result.result.toLowerCase();
                if (owner !== user)
                    continue;
                out.push({ ...candidate, amount: '1' });
            }
            else {
                const amt = result.result;
                if (amt <= 0n)
                    continue;
                out.push({ ...candidate, amount: amt.toString() });
            }
        }
        return out;
    }
}
//# sourceMappingURL=nft-chain-verifier.js.map