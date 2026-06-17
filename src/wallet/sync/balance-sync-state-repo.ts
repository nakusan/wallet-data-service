import type { Pool, PoolClient } from 'pg';

export type BalanceSyncType = 'erc20' | 'nft';

export interface LaggingContract {
  contractAddress: string;
  lastSynced: bigint;
  /** 该合约物化上界：LEAST(合约 checkpoint, finalized_block) */
  safeUpper: bigint;
}

/** 无物化行时，从 start_block - 1 起算（与索引器首段 fromBlock 对齐）。 */
const INITIAL_SYNCED_EXPR = `GREATEST(COALESCE(mc.start_block, 0) - 1, -1)`;

/** 无 checkpoint 时与 INITIAL_SYNCED_EXPR 对齐，避免未索引合约被误判为 lagging。 */
const CHECKPOINT_FALLBACK_EXPR = INITIAL_SYNCED_EXPR;

const SAFE_UPPER_EXPR = `LEAST(COALESCE(cp.last_indexed_block, ${CHECKPOINT_FALLBACK_EXPR}), cs.finalized_block)`;

export class BalanceSyncStateRepo {
  async pickLaggingErc20(
    client: PoolClient,
    chainId: number,
    limit = 10,
  ): Promise<LaggingContract[]> {
    return this.pickLagging(client, chainId, 'erc20', `'ERC20'`, limit);
  }

  async pickLaggingNft(
    client: PoolClient,
    chainId: number,
    limit = 10,
  ): Promise<LaggingContract[]> {
    return this.pickLagging(
      client, chainId, 'nft', `'ERC721','ERC1155'`, limit,
    );
  }

  async setLastSynced(
    client: PoolClient,
    chainId: number,
    contractAddress: string,
    syncType: BalanceSyncType,
    block: bigint,
  ): Promise<void> {
    await client.query(
      `INSERT INTO balance_sync_state
         (chain_id, contract_address, sync_type, last_synced_block)
       VALUES ($1, lower($2), $3, $4)
       ON CONFLICT (chain_id, contract_address, sync_type) DO UPDATE
         SET last_synced_block = EXCLUDED.last_synced_block,
             updated_at = NOW()`,
      [chainId, contractAddress, syncType, block.toString()],
    );
  }

  /** reorg 后：将所有已越过 commonAncestor 的合约水位回退到 commonAncestor。 */
  async rewindAllAbove(
    client: PoolClient,
    chainId: number,
    syncType: BalanceSyncType,
    commonAncestor: bigint,
  ): Promise<void> {
    await client.query(
      `UPDATE balance_sync_state
       SET last_synced_block=$1, updated_at=NOW()
       WHERE chain_id=$2 AND sync_type=$3 AND last_synced_block > $1`,
      [commonAncestor.toString(), chainId, syncType],
    );
  }

  async hasAnyAbove(
    client: PoolClient,
    chainId: number,
    syncType: BalanceSyncType,
    commonAncestor: bigint,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT 1 FROM balance_sync_state
       WHERE chain_id=$1 AND sync_type=$2 AND last_synced_block > $3
       LIMIT 1`,
      [chainId, syncType, commonAncestor.toString()],
    );
    return rows.length > 0;
  }

  /** start_block 初始化后，将低于窗口下界的错误物化水位抬升对齐。 */
  async rewindBelowIfNeeded(
    pool: Pool,
    chainId: number,
    contractAddress: string,
    syncType: BalanceSyncType,
    minLastSynced: bigint,
  ): Promise<void> {
    await pool.query(
      `UPDATE balance_sync_state
       SET last_synced_block = $4, updated_at = NOW()
       WHERE chain_id = $1 AND lower(contract_address) = lower($2)
         AND sync_type = $3 AND last_synced_block < $4`,
      [chainId, contractAddress, syncType, minLastSynced.toString()],
    );
  }

  private async pickLagging(
    client: PoolClient,
    chainId: number,
    syncType: BalanceSyncType,
    tokenTypesSql: string,
    limit: number,
  ): Promise<LaggingContract[]> {
    const { rows } = await client.query(
      `SELECT lower(mc.address) AS contract_address,
              COALESCE(bss.last_synced_block, ${INITIAL_SYNCED_EXPR}) AS last_synced,
              ${SAFE_UPPER_EXPR} AS safe_upper
       FROM monitored_contracts mc
       INNER JOIN indexer_chain_state cs ON cs.chain_id = mc.chain_id
       LEFT JOIN indexer_checkpoints cp
         ON cp.chain_id = mc.chain_id
        AND lower(cp.contract_address) = lower(mc.address)
        AND cp.indexer_type = $2
       LEFT JOIN balance_sync_state bss
         ON bss.chain_id = mc.chain_id
        AND lower(bss.contract_address) = lower(mc.address)
        AND bss.sync_type = $2
       WHERE mc.chain_id = $1
         AND mc.is_active = true
         AND mc.token_type IN (${tokenTypesSql})
         AND COALESCE(bss.last_synced_block, ${INITIAL_SYNCED_EXPR}) < ${SAFE_UPPER_EXPR}
       ORDER BY last_synced ASC
       LIMIT $3`,
      [chainId, syncType, limit],
    );
    return rows.map((r) => ({
      contractAddress: r.contract_address as string,
      lastSynced: BigInt(r.last_synced as string),
      safeUpper: BigInt(r.safe_upper as string),
    }));
  }
}
