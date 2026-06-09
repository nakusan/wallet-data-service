-- 原生币（ETH/BNB 等）转账记录
-- 来源：eth_getBlockByNumber(includeTransactions=true)，过滤 value > 0 且 receipt.status = success
-- status=failed 表示交易本身失败（value 未实际转移），保留供历史查询
CREATE TABLE IF NOT EXISTS native_transfers (
  chain_id        INTEGER NOT NULL,
  tx_hash         VARCHAR(66) NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,
  tx_index        INTEGER NOT NULL,
  from_address    VARCHAR(42) NOT NULL,
  to_address      VARCHAR(42) NOT NULL,
  value_raw       NUMERIC(78, 0) NOT NULL,
  value_eth       NUMERIC(36, 18) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'indexed'
                    CHECK (status IN ('indexed', 'reorged')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, tx_hash, block_number)
) PARTITION BY RANGE (block_number);

CREATE TABLE IF NOT EXISTS native_transfers_p20000000_20500000
  PARTITION OF native_transfers FOR VALUES FROM (20000000) TO (20500000);
CREATE TABLE IF NOT EXISTS native_transfers_p20500000_21000000
  PARTITION OF native_transfers FOR VALUES FROM (20500000) TO (21000000);
CREATE TABLE IF NOT EXISTS native_transfers_p21000000_21500000
  PARTITION OF native_transfers FOR VALUES FROM (21000000) TO (21500000);
CREATE TABLE IF NOT EXISTS native_transfers_p21500000_22000000
  PARTITION OF native_transfers FOR VALUES FROM (21500000) TO (22000000);

CREATE INDEX IF NOT EXISTS idx_native_tf_from
  ON native_transfers (chain_id, from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_native_tf_to
  ON native_transfers (chain_id, to_address, block_number DESC);
