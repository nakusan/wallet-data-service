import type { PoolClient } from 'pg';
import { TEST_ADDRESSES, TEST_BLOCKS, TEST_CHAIN_ID, ANCESTOR_HASH } from './constants.js';

export async function insertMonitoredContract(
  client: PoolClient,
  params: {
    address?: string;
    tokenType?: 'ERC20' | 'ERC721' | 'ERC1155';
    symbol?: string;
    decimals?: number | null;
    startBlock?: bigint | null;
  } = {},
): Promise<void> {
  const address = (params.address ?? TEST_ADDRESSES.erc20Contract).toLowerCase();
  const tokenType = params.tokenType ?? 'ERC20';
  await client.query(
    `INSERT INTO monitored_contracts (chain_id, token_type, symbol, address, decimals, start_block, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [
      TEST_CHAIN_ID,
      tokenType,
      params.symbol ?? (tokenType === 'ERC20' ? 'USDT' : 'NFT'),
      address,
      params.decimals ?? (tokenType === 'ERC20' ? 6 : null),
      params.startBlock?.toString() ?? null,
    ],
  );
}

export async function insertErc20Transfer(
  client: PoolClient,
  params: {
    blockNumber: bigint;
    from: string;
    to: string;
    amountRaw: string;
    status?: 'indexed' | 'reorged';
    txHash?: string;
    logIndex?: number;
    contractAddress?: string;
    schema?: 'public' | 'archive';
  },
): Promise<void> {
  const table = params.schema === 'archive' ? 'archive.token_transfers' : 'token_transfers';
  const contract = (params.contractAddress ?? TEST_ADDRESSES.erc20Contract).toLowerCase();
  await client.query(
    `INSERT INTO ${table}
       (chain_id, contract_address, symbol, tx_hash, log_index, block_number,
        from_address, to_address, amount_raw, amount, status)
     VALUES ($1,$2,'USDT',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      TEST_CHAIN_ID,
      contract,
      params.txHash ?? `0xtx${params.blockNumber}`,
      params.logIndex ?? 0,
      params.blockNumber.toString(),
      params.from.toLowerCase(),
      params.to.toLowerCase(),
      params.amountRaw,
      '0',
      params.status ?? 'indexed',
    ],
  );
}

export async function insertNftTransfer(
  client: PoolClient,
  params: {
    blockNumber: bigint;
    tokenId: bigint;
    from: string;
    to: string;
    amount?: bigint;
    tokenStandard?: 'ERC721' | 'ERC1155';
    status?: 'indexed' | 'reorged';
    txHash?: string;
    logIndex?: number;
    batchIndex?: number;
    schema?: 'public' | 'archive';
  },
): Promise<void> {
  const table = params.schema === 'archive' ? 'archive.nft_transfers' : 'nft_transfers';
  const contract = TEST_ADDRESSES.nftContract.toLowerCase();
  const tokenStandard = params.tokenStandard ?? 'ERC721';
  await client.query(
    `INSERT INTO ${table}
       (chain_id, contract_address, token_id, token_standard, tx_hash, log_index, batch_index,
        block_number, from_address, to_address, amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      TEST_CHAIN_ID,
      contract,
      params.tokenId.toString(),
      tokenStandard,
      params.txHash ?? `0xnft${params.blockNumber}`,
      params.logIndex ?? 0,
      params.batchIndex ?? 0,
      params.blockNumber.toString(),
      params.from.toLowerCase(),
      params.to.toLowerCase(),
      (params.amount ?? 1n).toString(),
      params.status ?? 'indexed',
    ],
  );
}

export async function insertTokenBalance(
  client: PoolClient,
  holder: string,
  balanceRaw: string,
  lastBlock: bigint = TEST_BLOCKS.ancestor,
): Promise<void> {
  await client.query(
    `INSERT INTO token_balances
       (chain_id, contract_address, holder_address, symbol, decimals, balance_raw, last_transfer_block)
     VALUES ($1,$2,$3,'USDT',6,$4,$5)`,
    [
      TEST_CHAIN_ID,
      TEST_ADDRESSES.erc20Contract.toLowerCase(),
      holder.toLowerCase(),
      balanceRaw,
      lastBlock.toString(),
    ],
  );
}

export async function insertNftHolding(
  client: PoolClient,
  tokenId: bigint,
  owner: string,
  amount: bigint,
  lastBlock: bigint = TEST_BLOCKS.reorged2,
): Promise<void> {
  await client.query(
    `INSERT INTO nft_holdings
       (chain_id, contract_address, token_id, token_standard, owner_address, amount, last_transfer_block)
     VALUES ($1,$2,$3,'ERC721',$4,$5,$6)`,
    [
      TEST_CHAIN_ID,
      TEST_ADDRESSES.nftContract.toLowerCase(),
      tokenId.toString(),
      owner.toLowerCase(),
      amount.toString(),
      lastBlock.toString(),
    ],
  );
}

export async function setBalanceSyncWatermark(
  client: PoolClient,
  syncType: 'erc20' | 'nft',
  lastSyncedBlock: bigint,
  contractAddress?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO balance_sync_state (chain_id, contract_address, sync_type, last_synced_block)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chain_id, contract_address, sync_type) DO UPDATE
       SET last_synced_block = EXCLUDED.last_synced_block`,
    [
      TEST_CHAIN_ID,
      (contractAddress ?? TEST_ADDRESSES.erc20Contract).toLowerCase(),
      syncType,
      lastSyncedBlock.toString(),
    ],
  );
}

export async function insertBlockAnchor(
  client: PoolClient,
  blockNumber: bigint,
  blockHash: string = ANCESTOR_HASH,
  parentHash: string = '0x' + 'bb'.repeat(32),
): Promise<void> {
  await client.query(
    `INSERT INTO indexer_block_anchors (chain_id, block_number, block_hash, parent_hash)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (chain_id, block_number) DO UPDATE
       SET block_hash = EXCLUDED.block_hash, parent_hash = EXCLUDED.parent_hash`,
    [TEST_CHAIN_ID, blockNumber.toString(), blockHash, parentHash],
  );
}

export async function insertCheckpoint(
  client: PoolClient,
  blockNumber: bigint,
  indexerType: 'erc20' | 'nft' = 'erc20',
  contractAddress?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO indexer_checkpoints
       (chain_id, contract_address, indexer_type, last_indexed_block, last_finalized_block_hash)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (chain_id, contract_address, indexer_type) DO UPDATE
       SET last_indexed_block = EXCLUDED.last_indexed_block`,
    [
      TEST_CHAIN_ID,
      (contractAddress ?? TEST_ADDRESSES.erc20Contract).toLowerCase(),
      indexerType,
      blockNumber.toString(),
      ANCESTOR_HASH,
    ],
  );
}

export async function getTokenBalance(
  client: PoolClient,
  holder: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT balance_raw::text FROM token_balances
     WHERE chain_id=$1 AND contract_address=$2 AND holder_address=$3`,
    [TEST_CHAIN_ID, TEST_ADDRESSES.erc20Contract.toLowerCase(), holder.toLowerCase()],
  );
  return rows[0]?.balance_raw ?? null;
}

export async function countTokenBalances(client: PoolClient): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM token_balances WHERE chain_id=$1`,
    [TEST_CHAIN_ID],
  );
  return rows[0].cnt as number;
}

export async function getNftHoldingAmount(
  client: PoolClient,
  tokenId: bigint,
  owner: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT amount::text FROM nft_holdings
     WHERE chain_id=$1 AND contract_address=$2 AND token_id=$3 AND owner_address=$4`,
    [
      TEST_CHAIN_ID,
      TEST_ADDRESSES.nftContract.toLowerCase(),
      tokenId.toString(),
      owner.toLowerCase(),
    ],
  );
  return rows[0]?.amount ?? null;
}

export async function getSyncWatermark(
  client: PoolClient,
  syncType: 'erc20' | 'nft',
): Promise<bigint | null> {
  const contract = syncType === 'erc20'
    ? TEST_ADDRESSES.erc20Contract
    : TEST_ADDRESSES.nftContract;
  const { rows } = await client.query(
    `SELECT last_synced_block FROM balance_sync_state
     WHERE chain_id=$1 AND contract_address=$2 AND sync_type=$3`,
    [TEST_CHAIN_ID, contract.toLowerCase(), syncType],
  );
  return rows.length > 0 ? BigInt(rows[0].last_synced_block) : null;
}
