-- indexer_type 区分 ERC20 / NFT 两条索引流水线
CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  chain_id                  INTEGER NOT NULL,
  contract_address          VARCHAR(42) NOT NULL,
  indexer_type              VARCHAR(8) NOT NULL DEFAULT 'erc20'
                              CHECK (indexer_type IN ('erc20','nft')),
  last_indexed_block        BIGINT NOT NULL,
  last_finalized_block_hash VARCHAR(66),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, contract_address, indexer_type)
);
