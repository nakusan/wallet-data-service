import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { createPool } from './infrastructure/db/pool.js';
import { getRedis } from './infrastructure/cache/redis-client.js';
import { createChainClients } from './indexer/chain/viem-client.js';
import { IndexerApp } from './indexer/indexer-app.js';
import { BalanceSyncWorker } from './wallet/balance-sync-worker.js';
import { NftHoldingSyncWorker } from './wallet/nft-holding-sync-worker.js';
import { buildExpressApp } from './api/app.js';
import { logger } from './infrastructure/logger/logger.js';
async function main() {
    const env = loadEnv();
    const pool = createPool(env.DATABASE_URL);
    const redis = getRedis();
    const chain = createChainClients(env);
    // Indexer（ERC20 + NFT）
    const indexerApp = new IndexerApp(pool, env, chain);
    // 余额物化同步 Workers
    const balanceSyncWorker = new BalanceSyncWorker(pool, redis, env.CHAIN_ID, env.BALANCE_SYNC_INTERVAL_MS);
    const nftSyncWorker = new NftHoldingSyncWorker(pool, redis, env.CHAIN_ID, env.NFT_SYNC_INTERVAL_MS);
    // HTTP API
    const app = buildExpressApp(pool, redis, chain.http, env);
    const server = app.listen(env.PORT, () => {
        logger.info({ port: env.PORT }, 'HTTP server started');
    });
    // 优雅关闭
    const shutdown = async (signal) => {
        logger.info({ signal }, '收到关闭信号，开始优雅关闭');
        server.close();
        balanceSyncWorker.stop();
        nftSyncWorker.stop();
        await indexerApp.shutdown();
        await pool.end();
        await redis.quit();
        logger.info('已完全关闭');
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        logger.error({ err }, '未捕获异常');
        void shutdown('uncaughtException');
    });
    // 启动顺序：先跑 indexer backfill，再启动 workers
    await indexerApp.run();
    balanceSyncWorker.start();
    nftSyncWorker.start();
    logger.info('wallet-data-service 已完全启动');
}
main().catch((err) => {
    logger.error({ err }, '启动失败');
    process.exit(1);
});
//# sourceMappingURL=index.js.map