import { createPublicClient, http, webSocket } from 'viem';
import { mainnet } from 'viem/chains';
export function createChainClients(env) {
    const chain = mainnet;
    return {
        http: createPublicClient({ chain, transport: http(env.RPC_HTTP_URL) }),
        ws: createPublicClient({ chain, transport: webSocket(env.RPC_WS_URL) }),
    };
}
export async function getLatestBlockNumber(client) {
    return client.getBlockNumber();
}
export async function getSafeBlockNumber(client, confirmationDepth) {
    const latest = await getLatestBlockNumber(client);
    return latest - BigInt(confirmationDepth);
}
/**
 * 链上真正最终化（不可逆）的块号。
 *
 * 优先使用共识层暴露的 `finalized` 区块标签（PoS 以太坊等）。该标签由协议保证不可
 * reorg，是物化层最干净的安全上界。对不支持该标签的链/节点（PoW 链、部分 L2、老节点
 * 或部分 RPC 提供商），回退为 `latest - max(CONFIRMATION_DEPTH, REORG_SCAN_DEPTH)`，
 * 回退深度不浅于 reorg 扫描深度，避免「确认深度 < 可能 reorg 深度」的倒挂。
 */
export async function getFinalizedBlockNumber(client, env) {
    try {
        const block = await client.getBlock({ blockTag: 'finalized' });
        if (block?.number != null)
            return block.number;
    }
    catch {
        // 节点/链不支持 finalized 标签，走回退分支
    }
    const latest = await getLatestBlockNumber(client);
    const lag = BigInt(Math.max(env.CONFIRMATION_DEPTH, env.REORG_SCAN_DEPTH));
    return latest - lag >= 0n ? latest - lag : 0n;
}
export async function getBlockTimestamp(client, blockNumber) {
    try {
        const block = await client.getBlock({ blockNumber });
        return new Date(Number(block.timestamp) * 1000);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=viem-client.js.map