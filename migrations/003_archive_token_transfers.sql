CREATE SCHEMA IF NOT EXISTS archive;

CREATE TABLE IF NOT EXISTS archive.token_transfers (
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

CREATE INDEX IF NOT EXISTS idx_archive_tf_from_contract
  ON archive.token_transfers (chain_id, from_address, contract_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_archive_tf_to_contract
  ON archive.token_transfers (chain_id, to_address, contract_address, block_number DESC);
