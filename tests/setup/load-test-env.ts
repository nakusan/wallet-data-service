import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.test') });

/** 单元/集成测试用最小环境变量；可被 .env.test 覆盖 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5432/wallet_data_test';
process.env.RPC_HTTP_URL ??= 'http://127.0.0.1:8545';
process.env.RPC_WS_URL ??= 'ws://127.0.0.1:8546';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
process.env.LOG_LEVEL ??= 'error';
