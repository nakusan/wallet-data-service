import type { Pool } from 'pg';
import { createPool } from './pool.js';

export interface DbPools {
  api: Pool;
  worker: Pool;
}

export interface DbPoolsConfig {
  databaseUrl: string;
  apiMax: number;
  workerMax: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  apiStatementTimeoutMs: number;
  workerStatementTimeoutMs: number;
}

export function createDbPools(config: DbPoolsConfig): DbPools {
  const common = {
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
  };

  return {
    api: createPool(config.databaseUrl, {
      ...common,
      max: config.apiMax,
      application_name: 'wds-api',
      statementTimeoutMs: config.apiStatementTimeoutMs,
    }),
    worker: createPool(config.databaseUrl, {
      ...common,
      max: config.workerMax,
      application_name: 'wds-worker',
      statementTimeoutMs: config.workerStatementTimeoutMs,
    }),
  };
}
