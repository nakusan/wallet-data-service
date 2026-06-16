/** 无物化行时，从 start_block - 1 起算（与索引器首段 fromBlock 对齐）。 */
const INITIAL_SYNCED_EXPR = `GREATEST(COALESCE(mc.start_block, 0) - 1, -1)`;
/** 无 checkpoint 时与 INITIAL_SYNCED_EXPR 对齐，避免未索引合约被误判为 lagging。 */
const CHECKPOINT_FALLBACK_EXPR = INITIAL_SYNCED_EXPR;
const SAFE_UPPER_EXPR = `LEAST(COALESCE(cp.last_indexed_block, ${CHECKPOINT_FALLBACK_EXPR}), cs.finalized_block)`;
export class BalanceSyncStateRepo {
    async pickLaggingErc20(client, chainId, limit = 10) {
        return this.pickLagging(client, chainId, 'erc20', `'ERC20'`, limit);
    }
    async pickLaggingNft(client, chainId, limit = 10) {
        return this.pickLagging(client, chainId, 'nft', `'ERC721','ERC1155'`, limit);
    }
    async setLastSynced(client, chainId, contractAddress, syncType, block) {
        await client.query(`INSERT INTO balance_sync_state
         (chain_id, contract_address, sync_type, last_synced_block)
       VALUES ($1, lower($2), $3, $4)
       ON CONFLICT (chain_id, contract_address, sync_type) DO UPDATE
         SET last_synced_block = EXCLUDED.last_synced_block,
             updated_at = NOW()`, [chainId, contractAddress, syncType, block.toString()]);
    }
    /** reorg 后：将所有已越过 commonAncestor 的合约水位回退到 commonAncestor。 */
    async rewindAllAbove(client, chainId, syncType, commonAncestor) {
        await client.query(`UPDATE balance_sync_state
       SET last_synced_block=$1, updated_at=NOW()
       WHERE chain_id=$2 AND sync_type=$3 AND last_synced_block > $1`, [commonAncestor.toString(), chainId, syncType]);
    }
    async hasAnyAbove(client, chainId, syncType, commonAncestor) {
        const { rows } = await client.query(`SELECT 1 FROM balance_sync_state
       WHERE chain_id=$1 AND sync_type=$2 AND last_synced_block > $3
       LIMIT 1`, [chainId, syncType, commonAncestor.toString()]);
        return rows.length > 0;
    }
    async pickLagging(client, chainId, syncType, tokenTypesSql, limit) {
        const { rows } = await client.query(`SELECT lower(mc.address) AS contract_address,
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
       LIMIT $3`, [chainId, syncType, limit]);
        return rows.map((r) => ({
            contractAddress: r.contract_address,
            lastSynced: BigInt(r.last_synced),
            safeUpper: BigInt(r.safe_upper),
        }));
    }
}
//# sourceMappingURL=balance-sync-state-repo.js.map