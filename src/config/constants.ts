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

/** native 流水线的 checkpoint 占位地址（代替合约地址） */
export const NATIVE_SENTINEL_ADDRESS = '0x0000000000000000000000000000000000000000';

/** ERC721/1155 mint/burn 的零地址 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
