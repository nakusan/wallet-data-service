-- 热/温分区迁移审计
CREATE TABLE IF NOT EXISTS archive_manifest (
  id             BIGSERIAL PRIMARY KEY,
  chain_id       INTEGER NOT NULL DEFAULT 1,
  table_name     TEXT NOT NULL DEFAULT 'token_transfers',
  partition_name TEXT NOT NULL UNIQUE,
  block_from     BIGINT NOT NULL,
  block_to       BIGINT NOT NULL,
  row_count      BIGINT,
  storage_tier   TEXT NOT NULL CHECK (storage_tier IN ('hot', 'warm')),
  moved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_archive_manifest_blocks
  ON archive_manifest (table_name, block_from, block_to);
