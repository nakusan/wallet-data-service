import pg from 'pg';
import { TEST_CHAIN_ID } from './constants.js';

const TABLES = [
  'token_balances',
  'nft_holdings',
  'balance_sync_state',
  'indexer_checkpoints',
  'indexer_block_anchors',
  'archive_manifest',
  'monitored_contracts',
  'token_transfers',
  'nft_transfers',
  'archive.token_transfers',
  'archive.nft_transfers',
];

let pool: pg.Pool | null = null;

export function getTestPool(): pg.Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL 未设置，请配置 .env.test 或 tests/setup/load-test-env.ts');
    }
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function ensureArchivePartitions(): Promise<void> {
  const client = await getTestPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS archive.token_transfers_p21000000_21500000
        PARTITION OF archive.token_transfers FOR VALUES FROM (21000000) TO (21500000)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS archive.nft_transfers_p21000000_21500000
        PARTITION OF archive.nft_transfers FOR VALUES FROM (21000000) TO (21500000)
    `);
  } finally {
    client.release();
  }
}

export async function resetTestData(): Promise<void> {
  const client = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query(
      `INSERT INTO indexer_chain_state (chain_id, min_indexed_checkpoint, finalized_block)
       VALUES ($1, 0, 0)
       ON CONFLICT (chain_id) DO UPDATE
         SET min_indexed_checkpoint = 0,
             min_indexed_checkpoint_hash = NULL,
             finalized_block = 0,
             updated_at = NOW()`,
      [TEST_CHAIN_ID],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function assertSchemaReady(): Promise<void> {
  try {
    await getTestPool().query('SELECT 1 FROM monitored_contracts LIMIT 0');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `测试库不可用（${detail}）。\n`
      + '请复制 .env.test.example 为 .env.test，配置 DATABASE_URL，然后执行：\n'
      + '  pnpm test:db:setup\n'
      + '  pnpm test:integration',
    );
  }
}
