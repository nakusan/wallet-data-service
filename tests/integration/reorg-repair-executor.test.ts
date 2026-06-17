import { describe, it, expect, vi } from 'vitest';
import type { PublicClient } from 'viem';
import type { Env } from '../../src/config/env.js';
import { BlockAnchorRepo } from '../../src/indexer/db/block-anchor-repo.js';
import { ChainStateRepo } from '../../src/indexer/db/chain-state-repo.js';
import { CheckpointRepo } from '../../src/indexer/db/checkpoint-repo.js';
import { Erc20TransferRepo } from '../../src/indexer/erc20/transfer-repo.js';
import { ReorgRepairExecutor, type IndexerReorgModule } from '../../src/indexer/service/reorg-service.js';
import { Erc20BalanceRewinder } from '../../src/wallet/sync/materialization-rewinder.js';
import { WriteSemaphore } from '../../src/infrastructure/db/write-semaphore.js';
import { ContractWriteCoordinator } from '../../src/indexer/util/contract-write-coordinator.js';
import { TEST_ADDRESSES, TEST_BLOCKS, ANCESTOR_HASH, TEST_CHAIN_ID } from '../setup/constants.js';
import { getTestPool, withTransaction } from '../setup/db.js';
import {
  insertBlockAnchor,
  insertCheckpoint,
  insertErc20Transfer,
  insertMonitoredContract,
} from '../setup/fixtures.js';

function makeErc20Module(pool: ReturnType<typeof getTestPool>): IndexerReorgModule {
  const transferRepo = new Erc20TransferRepo(pool);
  return {
    indexerType: 'erc20',
    writeCoordinator: new ContractWriteCoordinator(),
    liveWatcher: null,
    repos: [transferRepo],
    rewinders: [new Erc20BalanceRewinder()],
    backfill: { fillSegmented: vi.fn(async () => {}) },
    getContracts: async () => [{
      id: 1,
      chainId: TEST_CHAIN_ID,
      tokenType: 'ERC20',
      symbol: 'USDT',
      address: TEST_ADDRESSES.erc20Contract,
      decimals: 6,
      startBlock: null,
      isActive: true,
    }],
  };
}

describe('ReorgRepairExecutor', () => {
  it('单次事务内回滚 transfer、checkpoint、anchor 并调用 rewinder', async () => {
    const pool = getTestPool();
    const env = { CHAIN_ID: TEST_CHAIN_ID } as Env;
    const httpClient = { getBlock: vi.fn() } as unknown as PublicClient;
    const checkpointRepo = new CheckpointRepo(pool);
    const chainStateRepo = new ChainStateRepo(pool);
    const blockAnchorRepo = new BlockAnchorRepo(pool);
    const writeSemaphore = new WriteSemaphore(1);

    const executor = new ReorgRepairExecutor(
      pool, env, httpClient, checkpointRepo, chainStateRepo, blockAnchorRepo, writeSemaphore,
    );

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
      });
      await insertCheckpoint(client, TEST_BLOCKS.reorged1);
      await insertBlockAnchor(client, TEST_BLOCKS.ancestor, ANCESTOR_HASH);
      await insertBlockAnchor(client, TEST_BLOCKS.reorged1, '0x' + 'cc'.repeat(32));

      await chainStateRepo.rewindTo(client, TEST_CHAIN_ID, TEST_BLOCKS.reorged1, '0x' + 'cc'.repeat(32));
    });

    await executor.repairChain([makeErc20Module(pool)], TEST_BLOCKS.ancestor);

    const client = await pool.connect();
    try {
      const transfers = await client.query(
        `SELECT block_number::text, status FROM token_transfers ORDER BY block_number`,
      );
      expect(transfers.rows).toEqual([
        { block_number: TEST_BLOCKS.ancestor.toString(), status: 'indexed' },
        { block_number: TEST_BLOCKS.reorged1.toString(), status: 'reorged' },
      ]);

      const cp = await checkpointRepo.get(TEST_CHAIN_ID, TEST_ADDRESSES.erc20Contract, 'erc20');
      expect(cp).toBe(TEST_BLOCKS.ancestor);

      const anchor = await blockAnchorRepo.get(TEST_CHAIN_ID, TEST_BLOCKS.reorged1);
      expect(anchor).toBeNull();

      const chainState = await chainStateRepo.get(TEST_CHAIN_ID);
      expect(chainState.minIndexedCheckpoint).toBe(TEST_BLOCKS.ancestor);
    } finally {
      client.release();
    }
  });
});
