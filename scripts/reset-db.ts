import 'dotenv/config';
import pg from 'pg';

const DATA_TABLES = [
  'token_balances',
  'nft_holdings',
  'balance_sync_state',
  'indexer_checkpoints',
  'indexer_block_anchors',
  'archive_manifest',
  'request_audit',
  'monitored_contracts',
  'token_transfers',
  'nft_transfers',
  'archive.token_transfers',
  'archive.nft_transfers',
] as const;

async function resetDb(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: contracts } = await client.query<{
      chain_id: number;
      token_type: string;
      symbol: string;
      address: string;
      decimals: number | null;
      start_block: string | null;
      is_active: boolean;
    }>(
      `SELECT chain_id, token_type, symbol, address, decimals, start_block::text, is_active
       FROM monitored_contracts`,
    );

    await client.query(
      `TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
    );

    await client.query(
      `INSERT INTO indexer_chain_state (chain_id, min_indexed_checkpoint, finalized_block)
       VALUES (1, 0, 0)
       ON CONFLICT (chain_id) DO UPDATE
         SET min_indexed_checkpoint = 0,
             min_indexed_checkpoint_hash = NULL,
             finalized_block = 0,
             updated_at = NOW()`,
    );

    for (const c of contracts) {
      await client.query(
        `INSERT INTO monitored_contracts
           (chain_id, token_type, symbol, address, decimals, start_block, is_active)
         VALUES ($1, $2, $3, lower($4), $5, $6, $7)`,
        [
          c.chain_id,
          c.token_type,
          c.symbol,
          c.address,
          c.decimals,
          c.start_block,
          c.is_active,
        ],
      );
      console.log(`[ok]   已恢复监控合约 ${c.symbol} (${c.address})`);
    }

    await client.query('COMMIT');
    console.log('数据库已清空并重置链状态（schema / migrations 保留）。');
    if (contracts.length === 0) {
      console.log('提示：monitored_contracts 为空，请按 README 注册合约后重启服务。');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

resetDb().catch((err) => {
  console.error(err);
  process.exit(1);
});
