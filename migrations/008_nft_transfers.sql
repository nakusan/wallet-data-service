-- NFT 转账事件热层
-- ERC721 Transfer(from, to, tokenId) 和 ERC1155 TransferSingle/TransferBatch 统一存储
-- ERC721: amount=1; ERC1155: amount=实际数量; TransferBatch 展开为多行（batch_index 区分）
CREATE TABLE IF NOT EXISTS nft_transfers (
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

CREATE TABLE IF NOT EXISTS nft_transfers_p20000000_20500000
  PARTITION OF nft_transfers FOR VALUES FROM (20000000) TO (20500000);
CREATE TABLE IF NOT EXISTS nft_transfers_p20500000_21000000
  PARTITION OF nft_transfers FOR VALUES FROM (20500000) TO (21000000);
CREATE TABLE IF NOT EXISTS nft_transfers_p21000000_21500000
  PARTITION OF nft_transfers FOR VALUES FROM (21000000) TO (21500000);
CREATE TABLE IF NOT EXISTS nft_transfers_p21500000_22000000
  PARTITION OF nft_transfers FOR VALUES FROM (21500000) TO (22000000);

CREATE INDEX IF NOT EXISTS idx_nft_tf_contract_block
  ON nft_transfers (chain_id, contract_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_nft_tf_from
  ON nft_transfers (chain_id, from_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_nft_tf_to
  ON nft_transfers (chain_id, to_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_nft_tf_token
  ON nft_transfers (chain_id, contract_address, token_id, block_number DESC);
