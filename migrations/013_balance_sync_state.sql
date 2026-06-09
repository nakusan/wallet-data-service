-- BalanceSyncWorker 和 NftHoldingSyncWorker 的水位线持久化
-- 进程重启后从 last_synced_block 续跑，不重算全量
CREATE TABLE IF NOT EXISTS balance_sync_state (
  chain_id          INTEGER NOT NULL,
  sync_type         VARCHAR(8) NOT NULL CHECK (sync_type IN ('erc20','nft')),
  last_synced_block BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, sync_type)
);

INSERT INTO balance_sync_state (chain_id, sync_type, last_synced_block)
VALUES (1, 'erc20', 0), (1, 'nft', 0)
ON CONFLICT DO NOTHING;
