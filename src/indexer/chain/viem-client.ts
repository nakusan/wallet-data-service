import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import type { Env } from '../../config/env.js';

export interface ChainClients {
  http: PublicClient;
  ws: PublicClient;
}

export function createChainClients(env: Env): ChainClients {
  const chain = mainnet;
  return {
    http: createPublicClient({ chain, transport: http(env.RPC_HTTP_URL) }),
    ws: createPublicClient({ chain, transport: webSocket(env.RPC_WS_URL) }),
  };
}

export async function getLatestBlockNumber(client: PublicClient): Promise<bigint> {
  return client.getBlockNumber();
}

export async function getSafeBlockNumber(
  client: PublicClient,
  confirmationDepth: number,
): Promise<bigint> {
  const latest = await getLatestBlockNumber(client);
  return latest - BigInt(confirmationDepth);
}

export async function getBlockTimestamp(
  client: PublicClient,
  blockNumber: bigint,
): Promise<Date | null> {
  try {
    const block = await client.getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000);
  } catch {
    return null;
  }
}
