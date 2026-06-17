/**
 * 创建 wallet_data_test 并执行 migration。
 * 用法：DATABASE_URL=postgresql://USER:PASS@localhost:5432/wallet_data_test pnpm test:db:setup
 *
 * 若库尚不存在，会先连到同 host 的 postgres 库创建测试库。
 */
import 'dotenv/config';
import { readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = 'wallet_data_test';

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function testDbUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function ensureDatabase(adminPool: pg.Pool): Promise<void> {
  const { rows } = await adminPool.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [TEST_DB],
  );
  if (rows.length > 0) {
    console.log(`[skip] database ${TEST_DB} already exists`);
    return;
  }
  await adminPool.query(`CREATE DATABASE ${TEST_DB}`);
  console.log(`[ok]   created database ${TEST_DB}`);
}

async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id        SERIAL PRIMARY KEY,
        filename  TEXT NOT NULL UNIQUE,
        run_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = join(__dirname, '..', 'migrations');
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM _migrations WHERE filename = $1',
        [file],
      );
      if (rows.length > 0) {
        console.log(`[skip] ${file}`);
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[ok]   ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[fail] ${file}`, err);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const adminPool = new pg.Pool({ connectionString: adminUrl(databaseUrl) });
  try {
    await ensureDatabase(adminPool);
  } finally {
    await adminPool.end();
  }

  const testPool = new pg.Pool({ connectionString: testDbUrl(databaseUrl) });
  try {
    await migrate(testPool);
    console.log('Test database ready.');
  } finally {
    await testPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
