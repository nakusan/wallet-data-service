-- 链级派生状态
-- min_indexed_checkpoint：各活跃合约 checkpoint 的 MIN（indexer 写入进度）
-- finalized_block：链上真正最终化块号（RPC finalized 标签；不支持时回退 latest - depth）
-- 物化 worker 安全上界 = LEAST(min_indexed_checkpoint, finalized_block)
CREATE TABLE IF NOT EXISTS indexer_chain_state (
  chain_id                    INTEGER PRIMARY KEY,
  min_indexed_checkpoint      BIGINT NOT NULL DEFAULT 0,
  min_indexed_checkpoint_hash VARCHAR(66),
  finalized_block             BIGINT NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_chain_state (chain_id, min_indexed_checkpoint, finalized_block)
VALUES (1, 0, 0) ON CONFLICT (chain_id) DO NOTHING;
