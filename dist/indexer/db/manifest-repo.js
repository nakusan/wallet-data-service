export class ManifestRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async recordMove(params) {
        await this.pool.query(`INSERT INTO archive_manifest
         (chain_id, table_name, partition_name, block_from, block_to, row_count, storage_tier, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'warm',$7)
       ON CONFLICT (partition_name) DO NOTHING`, [
            params.chainId,
            params.tableName,
            params.partitionName,
            params.blockFrom.toString(),
            params.blockTo.toString(),
            params.rowCount?.toString() ?? null,
            params.notes ?? null,
        ]);
    }
}
//# sourceMappingURL=manifest-repo.js.map