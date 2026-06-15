export const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
] as const;

export const ERC721_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
] as const;

export const ERC1155_ABI = [
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
] as const;

export const BATCH_INSERT_SIZE = 100;

/** ERC721/1155 mint/burn 的零地址 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * 物化层事务级 advisory lock 的 classid。
 * 与 chain_id 组成锁键（pg_advisory_xact_lock(classid, chain_id)），
 * 用于在 SyncWorker 同步与 ReorgRepairExecutor 回滚之间做互斥，避免读到 reorg 半成品状态。
 */
export const MATERIALIZATION_LOCK_CLASS = 0x5741_4c54; // "WALT"
