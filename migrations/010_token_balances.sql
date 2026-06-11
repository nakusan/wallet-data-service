-- ERC20 余额物化快照，由 BalanceSyncWorker 增量维护
CREATE TABLE IF NOT EXISTS token_balances (
  chain_id            INTEGER NOT NULL,
  contract_address    VARCHAR(42) NOT NULL,
  holder_address      VARCHAR(42) NOT NULL,
  symbol              VARCHAR(64) NOT NULL,
  decimals            SMALLINT NOT NULL,
  balance_raw         NUMERIC(78, 0) NOT NULL DEFAULT 0,
  last_transfer_block BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, contract_address, holder_address)
);

-- 钱包地址查所有代币余额（核心查询路径）
CREATE INDEX IF NOT EXISTS idx_tb_holder_nonzero
  ON token_balances (chain_id, holder_address, updated_at DESC)
  WHERE balance_raw > 0;

-- 合约 Top N 持有者（核心查询路径）
CREATE INDEX IF NOT EXISTS idx_tb_contract_balance_desc
  ON token_balances (chain_id, contract_address, balance_raw DESC)
  WHERE balance_raw > 0;
