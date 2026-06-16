import { defineChain } from 'viem';
import { mainnet, polygon, arbitrum, optimism } from 'viem/chains';
const KNOWN = {
    1: mainnet,
    137: polygon,
    42161: arbitrum,
    10: optimism,
};
export function resolveChain(chainId) {
    const known = KNOWN[chainId];
    if (known)
        return known;
    return defineChain({
        id: chainId,
        name: `chain-${chainId}`,
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
        rpcUrls: { default: { http: [], webSocket: [] } },
    });
}
//# sourceMappingURL=resolve-chain.js.map