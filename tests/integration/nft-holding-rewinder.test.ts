import { describe, it, expect } from 'vitest';
import { NftTransferRepo } from '../../src/indexer/nft/transfer-repo.js';
import { NftHoldingRewinder } from '../../src/wallet/sync/materialization-rewinder.js';
import { TEST_ADDRESSES, TEST_BLOCKS } from '../setup/constants.js';
import { getTestPool, withTransaction } from '../setup/db.js';
import {
  getNftHoldingAmount,
  getSyncWatermark,
  insertMonitoredContract,
  insertNftHolding,
  insertNftTransfer,
  setBalanceSyncWatermark,
} from '../setup/fixtures.js';

describe('NftHoldingRewinder', () => {
  const rewinder = new NftHoldingRewinder();
  const tokenId = 42n;

  it('物化水位未越过 ancestor 时早退', async () => {
    await withTransaction(async (client) => {
      await insertMonitoredContract(client, {
        address: TEST_ADDRESSES.nftContract,
        tokenType: 'ERC721',
      });
      await setBalanceSyncWatermark(client, 'nft', TEST_BLOCKS.ancestor, TEST_ADDRESSES.nftContract);
      await insertNftHolding(client, tokenId, TEST_ADDRESSES.holderB, 1n, TEST_BLOCKS.ancestor);

      await rewinder.rewindForReorg(client, 1, TEST_BLOCKS.ancestor);

      expect(await getNftHoldingAmount(client, tokenId, TEST_ADDRESSES.holderB)).toBe('1');
    });
  });

  it('reorg 后重算受影响 token 的持有者', async () => {
    const transferRepo = new NftTransferRepo(getTestPool());

    await withTransaction(async (client) => {
      await insertMonitoredContract(client, {
        address: TEST_ADDRESSES.nftContract,
        tokenType: 'ERC721',
      });
      await insertNftTransfer(client, {
        blockNumber: TEST_BLOCKS.ancestor,
        tokenId,
        from: TEST_ADDRESSES.holderA,
        to: TEST_ADDRESSES.holderB,
        txHash: '0xnft100',
      });
      await insertNftTransfer(client, {
        blockNumber: TEST_BLOCKS.reorged1,
        tokenId,
        from: TEST_ADDRESSES.holderB,
        to: TEST_ADDRESSES.holderC,
        txHash: '0xnft101',
      });
      await setBalanceSyncWatermark(client, 'nft', TEST_BLOCKS.reorged1, TEST_ADDRESSES.nftContract);
      await insertNftHolding(client, tokenId, TEST_ADDRESSES.holderC, 1n, TEST_BLOCKS.reorged1);

      await transferRepo.markReorgedAfterBlock(
        client, 1, TEST_ADDRESSES.nftContract, TEST_BLOCKS.ancestor,
      );
      await rewinder.rewindForReorg(client, 1, TEST_BLOCKS.ancestor);

      expect(await getNftHoldingAmount(client, tokenId, TEST_ADDRESSES.holderB)).toBe('1');
      expect(await getNftHoldingAmount(client, tokenId, TEST_ADDRESSES.holderC)).toBeNull();
      expect(await getSyncWatermark(client, 'nft')).toBe(TEST_BLOCKS.ancestor);
    });
  });

  it('archive 表中的 NFT 转账参与重算', async () => {
    const transferRepo = new NftTransferRepo(getTestPool());

    await withTransaction(async (client) => {
      await insertMonitoredContract(client, {
        address: TEST_ADDRESSES.nftContract,
        tokenType: 'ERC721',
      });
      await insertNftTransfer(client, {
        blockNumber: TEST_BLOCKS.ancestor,
        tokenId,
        from: TEST_ADDRESSES.holderA,
        to: TEST_ADDRESSES.holderB,
        txHash: '0xnft100',
      });
      await insertNftTransfer(client, {
        blockNumber: TEST_BLOCKS.reorged1,
        tokenId,
        from: TEST_ADDRESSES.holderB,
        to: TEST_ADDRESSES.holderC,
        txHash: '0xnft101',
        schema: 'archive',
      });
      await setBalanceSyncWatermark(client, 'nft', TEST_BLOCKS.reorged1, TEST_ADDRESSES.nftContract);
      await insertNftHolding(client, tokenId, TEST_ADDRESSES.holderC, 1n, TEST_BLOCKS.reorged1);

      await transferRepo.markReorgedAfterBlock(
        client, 1, TEST_ADDRESSES.nftContract, TEST_BLOCKS.ancestor,
      );
      await rewinder.rewindForReorg(client, 1, TEST_BLOCKS.ancestor);

      expect(await getNftHoldingAmount(client, tokenId, TEST_ADDRESSES.holderB)).toBe('1');
      expect(await getNftHoldingAmount(client, tokenId, TEST_ADDRESSES.holderC)).toBeNull();
    });
  });
});
