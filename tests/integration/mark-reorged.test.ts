import { describe, it, expect } from 'vitest';
import { Erc20TransferRepo } from '../../src/indexer/erc20/transfer-repo.js';
import { NftTransferRepo } from '../../src/indexer/nft/transfer-repo.js';
import { TEST_ADDRESSES, TEST_BLOCKS } from '../setup/constants.js';
import { getTestPool, withTransaction } from '../setup/db.js';
import {
  insertErc20Transfer,
  insertMonitoredContract,
  insertNftTransfer,
} from '../setup/fixtures.js';

describe('markReorgedAfterBlock', () => {
  it('ERC20：仅将 commonAncestor 之后的 indexed 行标为 reorged', async () => {
    const pool = getTestPool();
    const repo = new Erc20TransferRepo(pool);

    await withTransaction(async (client) => {
      await insertMonitoredContract(client);
      await insertErc20Transfer(client, {
        blockNumber: TEST_BLOCKS.ancestor,
        from: TEST_ADDRESSES.holderA,
        to: TEST_ADDRESSES.holderB,
        amountRaw: '1000',
        txHash: '0xtx100',
        logIndex: 0,
      });
      await insertErc20Transfer(client, {
        blockNumber: TEST_BLOCKS.reorged1,
        from: TEST_ADDRESSES.holderB,
        to: TEST_ADDRESSES.holderC,
        amountRaw: '300',
        txHash: '0xtx101',
        logIndex: 0,
      });
      await insertErc20Transfer(client, {
        blockNumber: TEST_BLOCKS.reorged2,
        from: TEST_ADDRESSES.holderB,
        to: TEST_ADDRESSES.holderD,
        amountRaw: '200',
        txHash: '0xtx102',
        logIndex: 0,
      });

      const updated = await repo.markReorgedAfterBlock(
        client, 1, TEST_ADDRESSES.erc20Contract, TEST_BLOCKS.ancestor,
      );
      expect(updated).toBe(2);

      const { rows } = await client.query(
        `SELECT block_number::text, status FROM token_transfers
         WHERE chain_id=1 ORDER BY block_number`,
      );
      expect(rows).toEqual([
        { block_number: TEST_BLOCKS.ancestor.toString(), status: 'indexed' },
        { block_number: TEST_BLOCKS.reorged1.toString(), status: 'reorged' },
        { block_number: TEST_BLOCKS.reorged2.toString(), status: 'reorged' },
      ]);
    });
  });

  it('NFT：仅将 commonAncestor 之后的 indexed 行标为 reorged', async () => {
    const pool = getTestPool();
    const repo = new NftTransferRepo(pool);

    await withTransaction(async (client) => {
      await insertMonitoredContract(client, {
        address: TEST_ADDRESSES.nftContract,
        tokenType: 'ERC721',
      });
      await insertNftTransfer(client, {
        blockNumber: TEST_BLOCKS.ancestor,
        tokenId: 1n,
        from: TEST_ADDRESSES.holderA,
        to: TEST_ADDRESSES.holderB,
      });
      await insertNftTransfer(client, {
        blockNumber: TEST_BLOCKS.reorged1,
        tokenId: 1n,
        from: TEST_ADDRESSES.holderB,
        to: TEST_ADDRESSES.holderC,
        txHash: '0xnft101',
      });

      const updated = await repo.markReorgedAfterBlock(
        client, 1, TEST_ADDRESSES.nftContract, TEST_BLOCKS.ancestor,
      );
      expect(updated).toBe(1);

      const { rows } = await client.query(
        `SELECT block_number::text, status FROM nft_transfers ORDER BY block_number`,
      );
      expect(rows[1].status).toBe('reorged');
      expect(rows[0].status).toBe('indexed');
    });
  });
});
