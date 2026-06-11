import { parseAbi } from 'viem';

export const erc20BalanceAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

export const erc721ReadAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

export const erc1155ReadAbi = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
]);
