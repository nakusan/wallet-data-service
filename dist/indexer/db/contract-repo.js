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
}
//# sourceMappingURL=contract-repo.js.map