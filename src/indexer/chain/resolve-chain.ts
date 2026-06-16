import { defineChain, type Chain } from 'viem';
import { mainnet, polygon, arbitrum, optimism } from 'viem/chains';

const KNOWN: Record<number, Chain> = {
  1: mainnet,
  137: polygon,
  42161: arbitrum,
  10: optimism,
};

export function resolveChain(chainId: number): Chain {
  const known = KNOWN[chainId];
  if (known) return known;

  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [], webSocket: [] } },
  });
}
