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

  logger.info(
    { flow: 'startup', rpcHttp: env.RPC_HTTP_URL.replace(/\/v2\/\S+/, '/v2/***') },
    '正在连接 RPC',
  );
  const rpcChainId = await chain.http.getChainId();
  if (rpcChainId !== env.CHAIN_ID) {
    throw new Error(
      `CHAIN_ID=${env.CHAIN_ID} 与 RPC eth_chainId=${rpcChainId} 不一致，请检查配置`,
    );
  }
  logger.info({ flow: 'startup', chainId: rpcChainId }, 'RPC 连接成功，chainId 校验通过');

  const indexerApp = new IndexerApp(workerPool, env, chain, writeSemaphore);

  const balanceSyncWorker = new BalanceSyncWorker(
    workerPool, redis, env.CHAIN_ID, env.BALANCE_SYNC_INTERVAL_MS, writeSemaphore,
  );
  const nftSyncWorker = new NftHoldingSyncWorker(
    workerPool, redis, env.CHAIN_ID, env.NFT_SYNC_INTERVAL_MS, writeSemaphore,
  );

  const app = buildExpressApp(apiPool, redis, chain.http, env);
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP server started');
  });

  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceTimer = setTimeout(() => {
      logger.fatal({ signal, exitCode }, '优雅关闭超时，强制退出');
      process.exit(exitCode || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    let code = exitCode;
    try {
      logger.info({ signal, exitCode }, '收到关闭信号，开始优雅关闭');
      server.close();
      balanceSyncWorker.stop();
      nftSyncWorker.stop();
      await indexerApp.shutdown();
      await Promise.all([apiPool.end(), workerPool.end()]);
      await redis.quit();
      logger.info('已完全关闭');
    } catch (err) {
      logger.error({ err }, '优雅关闭失败');
      code = code || 1;
    } finally {
      clearTimeout(forceTimer);
      process.exit(code);
    }
  };

  const fatal = (label: string, err: unknown) => {
    logger.fatal({ err }, label);
    void shutdown(label, 1).catch((e) => {
      logger.fatal({ err: e }, 'shutdown 自身失败');
      process.exit(1);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('uncaughtException', (err) => fatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

  logger.info({ flow: 'startup' }, '正在启动索引器');
  await indexerApp.run();
  logger.info({ flow: 'startup' }, '索引器就绪，正在启动物化同步 worker');
  balanceSyncWorker.start();
  nftSyncWorker.start();

  logger.info({ flow: 'startup', chainId: env.CHAIN_ID, port: env.PORT }, 'wallet-data-service 已完全启动');
}

main().catch((err) => {
  logger.error({ err }, '启动失败');
  process.exit(1);
});
