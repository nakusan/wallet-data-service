-- BalanceSyncWorker / NftHoldingSyncWorker 物化水位线（按合约 × sync_type）
-- 与 indexer_checkpoints 对齐；进程重启续跑；运行期新增合约从 start_block 独立 catch-up
CREATE TABLE IF NOT EXISTS balance_sync_state (
  chain_id          INTEGER NOT NULL,
  contract_address  VARCHAR(42) NOT NULL,
  sync_type         VARCHAR(8) NOT NULL CHECK (sync_type IN ('erc20','nft')),
  last_synced_block BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, contract_address, sync_type)
);

CREATE INDEX IF NOT EXISTS idx_balance_sync_state_lagging
  ON balance_sync_state (chain_id, sync_type, last_synced_block);
