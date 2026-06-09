-- 统一合约注册表：ERC20 / ERC721 / ERC1155 共用
-- decimals 对 NFT 为 NULL；symbol 对 NFT 为集合名称
CREATE TABLE IF NOT EXISTS monitored_contracts (
  id              SERIAL PRIMARY KEY,
  chain_id        INTEGER NOT NULL DEFAULT 1,
  token_type      VARCHAR(8) NOT NULL DEFAULT 'ERC20'
                    CHECK (token_type IN ('ERC20','ERC721','ERC1155')),
  symbol          VARCHAR(64) NOT NULL,
  address         VARCHAR(42) NOT NULL,
  decimals        SMALLINT,
  start_block     BIGINT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, address)
);

CREATE INDEX IF NOT EXISTS idx_monitored_contracts_active
  ON monitored_contracts (chain_id, is_active, token_type);
