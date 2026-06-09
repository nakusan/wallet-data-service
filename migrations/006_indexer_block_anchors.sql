-- 已确认块的 hash/parent_hash 快照；与 RPC 比对检测 reorg
CREATE TABLE IF NOT EXISTS indexer_block_anchors (
  chain_id      INTEGER NOT NULL,
  block_number  BIGINT NOT NULL,
  block_hash    VARCHAR(66) NOT NULL,
  parent_hash   VARCHAR(66) NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, block_number)
);

CREATE INDEX IF NOT EXISTS idx_block_anchors_chain_num
  ON indexer_block_anchors (chain_id, block_number DESC);
