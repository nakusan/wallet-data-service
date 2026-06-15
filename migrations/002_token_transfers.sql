-- ERC20 转账事件热层（分区表）
-- 预建分区覆盖主网当前高度附近；更低区块需后续扩展分区策略，原型请从链头附近起扫（见 INDEXER_START_LOOKBACK_BLOCKS）
-- status: indexed=有效数据；reorged=重组作废（查询需过滤 indexed）
CREATE TABLE IF NOT EXISTS token_transfers (
  chain_id         INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,
  symbol           VARCHAR(16) NOT NULL,
  tx_hash          VARCHAR(66) NOT NULL,
  log_index        INTEGER NOT NULL,
  block_number     BIGINT NOT NULL,
  block_timestamp  TIMESTAMPTZ,
  from_address     VARCHAR(42) NOT NULL,
  to_address       VARCHAR(42) NOT NULL,
  amount_raw       NUMERIC(78, 0) NOT NULL,
  amount           NUMERIC(36, 18) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'indexed'
                     CHECK (status IN ('indexed', 'reorged')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, tx_hash, log_index, block_number)
) PARTITION BY RANGE (block_number);

CREATE TABLE IF NOT EXISTS token_transfers_p20000000_20500000
  PARTITION OF token_transfers FOR VALUES FROM (20000000) TO (20500000);
CREATE TABLE IF NOT EXISTS token_transfers_p20500000_21000000
  PARTITION OF token_transfers FOR VALUES FROM (20500000) TO (21000000);
CREATE TABLE IF NOT EXISTS token_transfers_p21000000_21500000
  PARTITION OF token_transfers FOR VALUES FROM (21000000) TO (21500000);
CREATE TABLE IF NOT EXISTS token_transfers_p21500000_22000000
  PARTITION OF token_transfers FOR VALUES FROM (21500000) TO (22000000);

CREATE INDEX IF NOT EXISTS idx_tf_contract_block
  ON token_transfers (chain_id, contract_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tf_from
  ON token_transfers (chain_id, from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tf_to
  ON token_transfers (chain_id, to_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tf_from_contract
  ON token_transfers (chain_id, from_address, contract_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tf_to_contract
  ON token_transfers (chain_id, to_address, contract_address, block_number DESC);
