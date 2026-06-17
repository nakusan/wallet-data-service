import type { MonitoredContract } from '../../../src/indexer/domain/types.js';

export function makeErc20Contract(overrides: Partial<MonitoredContract> = {}): MonitoredContract {
  return {
    id: 1,
    chainId: 1,
    tokenType: 'ERC20',
    symbol: 'USDT',
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    decimals: 6,
    startBlock: null,
    isActive: true,
    ...overrides,
  };
}

export function makeNftContract(
  tokenType: 'ERC721' | 'ERC1155',
  overrides: Partial<MonitoredContract> = {},
): MonitoredContract {
  return {
    id: 2,
    chainId: 1,
    tokenType,
    symbol: 'NFT',
    address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    decimals: null,
    startBlock: null,
    isActive: true,
    ...overrides,
  };
}
