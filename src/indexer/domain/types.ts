export type TokenType = 'ERC20' | 'ERC721' | 'ERC1155';
export type IndexerType = 'erc20' | 'nft';

export interface MonitoredContract {
  id: number;
  chainId: number;
  tokenType: TokenType;
  symbol: string;
  address: string;
  decimals: number | null;
  startBlock: bigint | null;
  isActive: boolean;
}

export interface TransferRecord {
  chainId: number;
  contractAddress: string;
  symbol: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: Date | null;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  amount: string;
}

export interface NftTransferRecord {
  chainId: number;
  contractAddress: string;
  tokenId: bigint;
  tokenStandard: 'ERC721' | 'ERC1155';
  txHash: string;
  logIndex: number;
  batchIndex: number;
  blockNumber: bigint;
  blockTimestamp: Date | null;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
}

export interface Checkpoint {
  chainId: number;
  contractAddress: string;
  indexerType: IndexerType;
  lastIndexedBlock: bigint;
}

export interface ChainState {
  chainId: number;
  /** 各活跃合约 checkpoint 的 MIN，用于 reorg 扫描与链级监控（物化上界已按合约计算） */
  minIndexedCheckpoint: bigint;
  minIndexedCheckpointHash: string | null;
  /** 链上真正最终化（不可逆）的块号，物化 worker 的安全上界 */
  finalizedBlock: bigint;
}

export interface BlockAnchor {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  parentHash: string;
}

export interface PartitionInfo {
  partitionName: string;
  blockFrom: bigint;
  blockTo: bigint;
  schema: 'public' | 'archive';
}

export interface ArchiveManifestEntry {
  partitionName: string;
  blockFrom: bigint;
  blockTo: bigint;
  rowCount: bigint | null;
  storageTier: 'hot' | 'warm';
}
