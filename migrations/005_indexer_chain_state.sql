-- 链级最终化上界（派生值）
CREATE TABLE IF NOT EXISTS indexer_chain_state (
  chain_id                  INTEGER PRIMARY KEY,
  last_finalized_block      BIGINT NOT NULL DEFAULT 0,
  last_finalized_block_hash VARCHAR(66),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_chain_state (chain_id, last_finalized_block)
VALUES (1, 0) ON CONFLICT (chain_id) DO NOTHING;
