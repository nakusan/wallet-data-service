import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { createDbPools } from './infrastructure/db/pools.js';
import { WriteSemaphore } from './infrastructure/db/write-semaphore.js';
import { getRedis } from './infrastructure/cache/redis-client.js';
import { createChainClients } from './indexer/chain/viem-client.js';
import { IndexerApp } from './indexer/indexer-app.js';
import { BalanceSyncWorker } from './wallet/sync/balance-sync-worker.js';
import { NftHoldingSyncWorker } from './wallet/sync/nft-holding-sync-worker.js';
import { buildExpressApp } from './api/app.js';
import { logger } from './infrastructure/logger/logger.js';
async function main() {
    const env = loadEnv();
    const { api: apiPool, worker: workerPool } = createDbPools({
        databaseUrl: env.DATABASE_URL,
        apiMax: env.DB_API_POOL_MAX,
        workerMax: env.DB_WORKER_POOL_MAX,
        connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
        idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
        apiStatementTimeoutMs: env.DB_API_STATEMENT_TIMEOUT_MS,
        workerStatementTimeoutMs: env.DB_WORKER_STATEMENT_TIMEOUT_MS,
    });
    const writeSemaphore = new WriteSemaphore(env.DB_MAX_CONCURRENT_WRITE_TX);
    const redis = getRedis();
    const chain = createChainClients(env);
    const indexerApp = new IndexerApp(workerPool, env, chain, writeSemaphore);
    const balanceSyncWorker = new BalanceSyncWorker(workerPool, redis, env.CHAIN_ID, env.BALANCE_SYNC_INTERVAL_MS, writeSemaphore);
    const nftSyncWorker = new NftHoldingSyncWorker(workerPool, redis, env.CHAIN_ID, env.NFT_SYNC_INTERVAL_MS, writeSemaphore);
    const app = buildExpressApp(apiPool, redis, chain.http, env);
    const server = app.listen(env.PORT, () => {
        logger.info({ port: env.PORT }, 'HTTP server started');
    });
    const shutdown = async (signal) => {
        logger.info({ signal }, '收到关闭信号，开始优雅关闭');
        server.close();
        balanceSyncWorker.stop();
        nftSyncWorker.stop();
        await indexerApp.shutdown();
        await Promise.all([apiPool.end(), workerPool.end()]);
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