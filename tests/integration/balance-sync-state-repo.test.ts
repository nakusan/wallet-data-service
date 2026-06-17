import { describe, it, expect, beforeEach } from 'vitest';
import { ContractRepo } from '../../src/indexer/db/contract-repo.js';
import { resolveIndexWindowStart } from '../../src/indexer/util/resolve-start-block.js';
import { BalanceSyncStateRepo } from '../../src/wallet/sync/balance-sync-state-repo.js';
import { TEST_ADDRESSES, TEST_CHAIN_ID } from '../setup/constants.js';
import { assertSchemaReady, getTestPool, resetTestData, withTransaction } from '../setup/db.js';
import {
  insertCheckpoint,
  insertMonitoredContract,
  setBalanceSyncWatermark,
} from '../setup/fixtures.js';

const LOOKBACK = 100n;
const HOT_MIN = 21_000_000n;

describe('start_block 初始化与物化起点', () => {
  const syncRepo = new BalanceSyncStateRepo();

  beforeEach(async () => {
    await assertSchemaReady();
    await resetTestData();
  });

  it('setStartBlockIfNull 写入后物化从 start_block - 1 起算', async () => {
    const pool = getTestPool();
    const contractRepo = new ContractRepo(pool);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE indexer_chain_state SET finalized_block = $1 WHERE chain_id = $2`,
        ['21000200', TEST_CHAIN_ID],
      );
      await insertMonitoredContract(client, { startBlock: null });
      await insertCheckpoint(client, 21_000_200n);
    });

    const resolved = resolveIndexWindowStart({
      startBlock: null,
      safeLatest: 21_000_200n,
      lookbackBlocks: LOOKBACK,
      hotPartitionMinBlock: HOT_MIN,
    });
    expect(resolved).toBe(21_000_100n);

    const updated = await contractRepo.setStartBlockIfNull(
      TEST_CHAIN_ID, TEST_ADDRESSES.erc20Contract, resolved,
    );
    expect(updated).toBe(true);

    await withTransaction(async (client) => {
      const lagging = await syncRepo.pickLaggingErc20(client, TEST_CHAIN_ID);
      expect(lagging).toHaveLength(1);
      expect(lagging[0].lastSynced).toBe(21_000_099n);
    });
  });

  it('rewindBelowIfNeeded 纠正过低的物化水位', async () => {
    const pool = getTestPool();

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE indexer_chain_state SET finalized_block = $1 WHERE chain_id = $2`,
        ['21000200', TEST_CHAIN_ID],
      );
      await insertMonitoredContract(client, { startBlock: 21_000_100n });
      await insertCheckpoint(client, 21_000_200n);
      await setBalanceSyncWatermark(client, 'erc20', 5000n);
    });

    await syncRepo.rewindBelowIfNeeded(
      pool, TEST_CHAIN_ID, TEST_ADDRESSES.erc20Contract, 'erc20', 21_000_099n,
    );

    await withTransaction(async (client) => {
      const lagging = await syncRepo.pickLaggingErc20(client, TEST_CHAIN_ID);
      expect(lagging[0].lastSynced).toBe(21_000_099n);
    });
  });
});
