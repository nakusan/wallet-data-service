import express from 'express';
import { pinoHttp } from 'pino-http';
import { CacheService } from '../infrastructure/cache/redis-client.js';
import { logger } from '../infrastructure/logger/logger.js';
import { BalanceService } from '../wallet/balance-service.js';
import { TxHistoryService } from '../wallet/tx-history-service.js';
import { HoldersService } from '../wallet/holders-service.js';
import { authRouter } from './routes/auth.js';
import { balancesRouter } from './routes/balances.js';
import { nftsRouter } from './routes/nfts.js';
import { transactionsRouter } from './routes/transactions.js';
import { holdersRouter } from './routes/holders.js';
import { errorHandler } from './middleware/error-handler.js';
export function buildExpressApp(pool, redis, httpClient, env) {
    const app = express();
    app.use(pinoHttp({ logger }));
    app.use(express.json());
    // 健康检查（无需鉴权）
    app.get('/v1/health', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            await redis.ping();
            res.json({ status: 'ok', ts: new Date().toISOString() });
        }
        catch (err) {
            res.status(503).json({ status: 'error', message: String(err) });
        }
    });
    const cache = new CacheService(redis);
    const balanceService = new BalanceService(pool, httpClient, cache, env.CHAIN_ID);
    const txService = new TxHistoryService(pool);
    const holdersService = new HoldersService(pool, cache, env.CHAIN_ID);
    app.use('/v1/auth', authRouter(pool));
    app.use('/v1', balancesRouter(balanceService, redis));
    app.use('/v1', nftsRouter(balanceService, redis));
    app.use('/v1', transactionsRouter(txService, redis));
    app.use('/v1', holdersRouter(holdersService, redis));
    app.use(errorHandler);
    return app;
}
//# sourceMappingURL=app.js.map