-- last_finalized_block 实为各合约 checkpoint 的 MIN（indexer 写入进度），并非链上真正最终化。
-- 正名为 min_indexed_checkpoint，避免误导。
ALTER TABLE indexer_chain_state
  RENAME COLUMN last_finalized_block TO min_indexed_checkpoint;
ALTER TABLE indexer_chain_state
  RENAME COLUMN last_finalized_block_hash TO min_indexed_checkpoint_hash;

-- 新增链上真正最终化块号：来自 RPC 的 finalized 区块标签，
-- 节点/链不支持时回退为 latest - max(CONFIRMATION_DEPTH, REORG_SCAN_DEPTH)。
-- 物化 worker 的硬上界之一，保证永不消费可被 reorg 的块。
ALTER TABLE indexer_chain_state
  ADD COLUMN IF NOT EXISTS finalized_block BIGINT NOT NULL DEFAULT 0;
