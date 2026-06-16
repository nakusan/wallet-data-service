import { z } from 'zod';
const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    CHAIN_ID: z.coerce.number().int().positive().default(1),
    DATABASE_URL: z.string().min(1),
    DB_API_POOL_MAX: z.coerce.number().int().positive().default(8),
    DB_WORKER_POOL_MAX: z.coerce.number().int().positive().default(12),
    DB_MAX_CONCURRENT_WRITE_TX: z.coerce.number().int().positive().default(3),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    DB_API_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    DB_WORKER_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    RPC_HTTP_URL: z.string().url(),
    RPC_WS_URL: z.string().url(),
    REDIS_URL: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(3000),
    CORS_ORIGINS: z.string().optional(),
    JSON_BODY_LIMIT: z.string().default('16kb'),
    JWT_SECRET: z.string().min(32),
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    CONFIRMATION_DEPTH: z.coerce.number().int().nonnegative().default(12),
    BACKFILL_MAX_BLOCK_RANGE: z.coerce.number().int().positive().default(2000),
    BACKFILL_OVERLAP_BLOCKS: z.coerce.number().int().nonnegative().default(2),
    /** 无 checkpoint 时相对安全块高的最大回看块数；start_block 为 NULL 或过低时以此为下界 */
    INDEXER_START_LOOKBACK_BLOCKS: z.coerce.number().int().nonnegative().default(100),
    HOT_RETAIN_BLOCKS: z.coerce.number().int().positive().default(648000),
    PARTITION_BLOCK_RANGE: z.coerce.number().int().positive().default(500000),
    PARTITION_ENSURE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    REORG_SCAN_DEPTH: z.coerce.number().int().positive().default(128),
    REORG_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    ARCHIVE_REORG_SAFETY_MARGIN: z.coerce.number().int().nonnegative().default(128),
    BALANCE_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    NFT_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});
let cached = null;
export function loadEnv() {
    if (cached)
        return cached;
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error('环境变量无效:', parsed.error.flatten().fieldErrors);
        process.exit(1);
    }
    cached = parsed.data;
    return cached;
}
//# sourceMappingURL=env.js.map