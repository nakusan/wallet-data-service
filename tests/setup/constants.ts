export const TEST_CHAIN_ID = 1;

export const TEST_ADDRESSES = {
  erc20Contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  nftContract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  holderA: '0x1111111111111111111111111111111111111111',
  holderB: '0x2222222222222222222222222222222222222222',
  holderC: '0x3333333333333333333333333333333333333333',
  holderD: '0x4444444444444444444444444444444444444444',
} as const;

/** migration 预建热分区范围内的块高 */
export const TEST_BLOCKS = {
  ancestor: 21_000_100n,
  reorged1: 21_000_101n,
  reorged2: 21_000_102n,
  /** 触发新建分区（高于 migration 上界 22000000） */
  newPartition: 22_000_001n,
} as const;

export const ANCESTOR_HASH = '0x' + 'aa'.repeat(32);
