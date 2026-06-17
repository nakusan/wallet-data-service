import { describe, it, expect } from 'vitest';
import { Erc20TransferRepo } from '../../src/indexer/erc20/transfer-repo.js';
import { Erc20BalanceRewinder } from '../../src/wallet/sync/materialization-rewinder.js';
import { TEST_ADDRESSES, TEST_BLOCKS } from '../setup/constants.js';
import { getTestPool, withTransaction } from '../setup/db.js';
import {
  getSyncWatermark,
  getTokenBalance,
  insertErc20Transfer,
  insertMonitoredContract,
  insertTokenBalance,
  setBalanceSyncWatermark,
} from '../setup/fixtures.js';

describe('Erc20BalanceRewinder', () => {
  const rewinder = new Erc20BalanceRewinder();

  async function seedBaseTransfers(client: import('pg').PoolClient): Promise<void> {
    await insertMonitoredContract(client);
    await insertErc20Transfer(client, {
      blockNumber: TEST_BLOCKS.ancestor,
      from: TEST_ADDRESSES.holderA,
      to: TEST_ADDRESSES.holderB,
      amountRaw: '1000',
      txHash: '0xtx100',
    });
    await insertErc20Transfer(client, {
      blockNumber: TEST_BLOCKS.reorged1,
      from: TEST_ADDRESSES.holderB,
      to: TEST_ADDRESSES.holderC,
      amountRaw: '300',
      txHash: '0xtx101',
    });
    await insertErc20Transfer(client, {
      blockNumber: TEST_BLOCKS.reorged2,
      from: TEST_ADDRESSES.holderB,
      to: TEST_ADDRESSES.holderD,
      amountRaw: '200',
      txHash: '0xtx102',
    });
  }

  it('物化水位未越过 ancestor 时早退', async () => {
    const pool = getTestPool();

    await withTransaction(async (client) => {
      await seedBaseTransfers(client);
      await setBalanceSyncWatermark(client, 'erc20', TEST_BLOCKS.ancestor);
      await insertTokenBalance(client, TEST_ADDRESSES.holderB, '1000', TEST_BLOCKS.ancestor);

      await rewinder.rewindForReorg(client, 1, TEST_BLOCKS.ancestor);

      expect(await getTokenBalance(client, TEST_ADDRESSES.holderB)).toBe('1000');
    });
  });

  it('reorg 后重算受影响 holder 余额', async () => {
    const pool = getTestPool();
    const transferRepo = new Erc20TransferRepo(pool);

    await withTransaction(async (client) => {
      await seedBaseTransfers(client);
      await setBalanceSyncWatermark(client, 'erc20', TEST_BLOCKS.reorged2);
      await insertTokenBalance(client, TEST_ADDRESSES.holderB, '500', TEST_BLOCKS.reorged2);
      await insertTokenBalance(client, TEST_ADDRESSES.holderC, '300', TEST_BLOCKS.reorged1);
      await insertTokenBalance(client, TEST_ADDRESSES.holderD, '200', TEST_BLOCKS.reorged2);

      await transferRepo.markReorgedAfterBlock(
        client, 1, TEST_ADDRESSES.erc20Contract, TEST_BLOCKS.ancestor,
      );
      await rewinder.rewindForReorg(client, 1, TEST_BLOCKS.ancestor);

      expect(await getTokenBalance(client, TEST_ADDRESSES.holderB)).toBe('1000');
      expect(await getTokenBalance(client, TEST_ADDRESSES.holderC)).toBeNull();
      expect(await getTokenBalance(client, TEST_ADDRESSES.holderD)).toBeNull();
      expect(await getSyncWatermark(client, 'erc20')).toBe(TEST_BLOCKS.ancestor);
    });
  });

  it('archive 表中的转账参与重算', async () => {
    const pool = getTestPool();
    const transferRepo = new Erc20TransferRepo(pool);

    await withTransaction(async (client) => {
      await insertMonitoredContract(client);
      await insertErc20Transfer(client, {
        blockNumber: TEST_BLOCKS.ancestor,
        from: TEST_ADDRESSES.holderA,
        to: TEST_ADDRESSES.holderB,
        amountRaw: '1000',
        txHash: '0xtx100',
      });
      await insertErc20Transfer(client, {
        blockNumber: TEST_BLOCKS.reorged1,
        from: TEST_ADDRESSES.holderB,
        to: TEST_ADDRESSES.holderC,
        amountRaw: '300',
        txHash: '0xtx101',
        schema: 'archive',
      });
      await setBalanceSyncWatermark(client, 'erc20', TEST_BLOCKS.reorged1);
      await insertTokenBalance(client, TEST_ADDRESSES.holderB, '700', TEST_BLOCKS.reorged1);
      await insertTokenBalance(client, TEST_ADDRESSES.holderC, '300', TEST_BLOCKS.reorged1);

      await transferRepo.markReorgedAfterBlock(
        client, 1, TEST_ADDRESSES.erc20Contract, TEST_BLOCKS.ancestor,
      );
      await rewinder.rewindForReorg(client, 1, TEST_BLOCKS.ancestor);

      expect(await getTokenBalance(client, TEST_ADDRESSES.holderB)).toBe('1000');
      expect(await getTokenBalance(client, TEST_ADDRESSES.holderC)).toBeNull();
    });
  });
});
