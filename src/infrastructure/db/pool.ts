import pg from 'pg';

export interface PoolOptions {
  max: number;
  application_name?: string;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMs?: number;
}

export function createPool(databaseUrl: string, opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max,
    application_name: opts.application_name,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
  });

  if (opts.statementTimeoutMs != null) {
    pool.on('connect', (client) => {
      void client.query(`SET statement_timeout = ${opts.statementTimeoutMs}`);
    });
  }

  return pool;
}

export type DbPool = pg.Pool;
