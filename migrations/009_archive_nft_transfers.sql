CREATE TABLE IF NOT EXISTS archive.nft_transfers (
  chain_id         INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,
  token_id         NUMERIC(78, 0) NOT NULL,
  token_standard   VARCHAR(8) NOT NULL CHECK (token_standard IN ('ERC721','ERC1155')),
  tx_hash          VARCHAR(66) NOT NULL,
  log_index        INTEGER NOT NULL,
  batch_index      SMALLINT NOT NULL DEFAULT 0,
  block_number     BIGINT NOT NULL,
  block_timestamp  TIMESTAMPTZ,
  from_address     VARCHAR(42) NOT NULL,
  to_address       VARCHAR(42) NOT NULL,
  amount           NUMERIC(78, 0) NOT NULL DEFAULT 1,
  status           VARCHAR(16) NOT NULL DEFAULT 'indexed'
                     CHECK (status IN ('indexed', 'reorged')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, tx_hash, log_index, batch_index, block_number)
) PARTITION BY RANGE (block_number);

CREATE INDEX IF NOT EXISTS idx_archive_nft_tf_from
  ON archive.nft_transfers (chain_id, from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_archive_nft_tf_to
  ON archive.nft_transfers (chain_id, to_address, block_number DESC);
