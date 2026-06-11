function rowToContract(row) {
    return {
        id: row.id,
        chainId: row.chain_id,
        tokenType: row.token_type.toUpperCase(),
        symbol: row.symbol,
        address: row.address.toLowerCase(),
        decimals: row.decimals != null ? row.decimals : null,
        startBlock: row.start_block != null ? BigInt(row.start_block) : null,
        isActive: row.is_active,
    };
}
export class ContractRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async findActive(chainId, tokenType) {
        const params = [chainId];
        let typeFilter = '';
        if (tokenType) {
            params.push(tokenType);
            typeFilter = ` AND token_type = $${params.length}`;
        }
        const { rows } = await this.pool.query(`SELECT id, chain_id, token_type, symbol, address, decimals, start_block, is_active
       FROM monitored_contracts
       WHERE chain_id = $1 AND is_active = true${typeFilter}
       ORDER BY id`, params);
        return rows.map(rowToContract);
    }
    async getStartBlock(chainId, contractAddress) {
        const { rows } = await this.pool.query(`SELECT start_block FROM monitored_contracts
       WHERE chain_id=$1 AND lower(address)=lower($2) AND is_active=true`, [chainId, contractAddress]);
        const val = rows[0]?.start_block;
        return val != null ? BigInt(val) : null;
    }
    /** 活跃 ERC20 监控合约中最小的 start_block（用于未指定 token 的交易历史说明）。 */
    async getMinErc20StartBlock(chainId) {
        const { rows } = await this.pool.query(`SELECT MIN(start_block) AS min_block FROM monitored_contracts
       WHERE chain_id=$1 AND is_active=true AND token_type='ERC20' AND start_block IS NOT NULL`, [chainId]);
        const val = rows[0]?.min_block;
        return val != null ? BigInt(val) : null;
    }
}
//# sourceMappingURL=contract-repo.js.map