/** 无物化行时，从 start_block - 1 起算（与索引器首段 fromBlock 对齐）。 */
const INITIAL_SYNCED_EXPR = `GREATEST(COALESCE(mc.start_block, 0) - 1, -1)`;
export class BalanceSyncStateRepo {
    async pickLaggingErc20(client, chainId, safeUpper, limit = 10) {
        return this.pickLagging(client, chainId, 'erc20', `'ERC20'`, safeUpper, limit);
    }
    async pickLaggingNft(client, chainId, safeUpper, limit = 10) {
        return this.pickLagging(client, chainId, 'nft', `'ERC721','ERC1155'`, safeUpper, limit);
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
    async pickLagging(client, chainId, syncType, tokenTypesSql, safeUpper, limit) {
        const { rows } = await client.query(`SELECT lower(mc.address) AS contract_address,
              COALESCE(bss.last_synced_block, ${INITIAL_SYNCED_EXPR}) AS last_synced
       FROM monitored_contracts mc
       LEFT JOIN balance_sync_state bss
         ON bss.chain_id = mc.chain_id
        AND lower(bss.contract_address) = lower(mc.address)
        AND bss.sync_type = $2
       WHERE mc.chain_id = $1
         AND mc.is_active = true
         AND mc.token_type IN (${tokenTypesSql})
         AND COALESCE(bss.last_synced_block, ${INITIAL_SYNCED_EXPR}) < $3
       ORDER BY last_synced ASC
       LIMIT $4`, [chainId, syncType, safeUpper.toString(), limit]);
        return rows.map((r) => ({
            contractAddress: r.contract_address,
            lastSynced: BigInt(r.last_synced),
        }));
    }
}
//# sourceMappingURL=balance-sync-state-repo.js.map