function parsePartitionBounds(name) {
    const match = name.match(/_p(\d+)_(\d+)$/);
    if (!match)
        return null;
    return { blockFrom: BigInt(match[1]), blockTo: BigInt(match[2]) };
}
export class PartitionRepo {
    pool;
    tableName;
    constructor(pool, tableName = 'token_transfers') {
        this.pool = pool;
        this.tableName = tableName;
    }
    async listHotPartitions() {
        const { rows } = await this.pool.query(`SELECT c.relname AS partition_name
       FROM pg_class c
       JOIN pg_inherits i ON c.oid = i.inhrelid
       JOIN pg_class p ON i.inhparent = p.oid
       JOIN pg_namespace n ON p.relnamespace = n.oid
       WHERE n.nspname = 'public' AND p.relname = $1
       ORDER BY c.relname`, [this.tableName]);
        const mapped = [];
        for (const r of rows) {
            const bounds = parsePartitionBounds(r.partition_name);
            if (!bounds)
                continue;
            mapped.push({ partitionName: r.partition_name, ...bounds, schema: 'public' });
        }
        return mapped.sort((a, b) => Number(a.blockFrom - b.blockFrom));
    }
    async isArchived(partitionName) {
        const { rows } = await this.pool.query(`SELECT 1 FROM archive_manifest WHERE partition_name=$1 AND storage_tier='warm'`, [partitionName]);
        return rows.length > 0;
    }
    async createHotPartition(partitionName, blockFrom, blockTo) {
        const exists = await this.hotPartitionExists(partitionName);
        if (exists)
            return;
        await this.pool.query(`CREATE TABLE public.${partitionName}
       PARTITION OF public.${this.tableName}
       FOR VALUES FROM (${blockFrom}) TO (${blockTo})`);
    }
    async getMaxHotPartitionUpperBound() {
        const parts = await this.listHotPartitions();
        if (parts.length === 0)
            return null;
        return parts[parts.length - 1].blockTo;
    }
    /** 热层最老分区的 block_from（migration 预建下界）；无分区时返回 null */
    async getMinHotPartitionLowerBound() {
        const parts = await this.listHotPartitions();
        if (parts.length === 0)
            return null;
        return parts[0].blockFrom;
    }
    async hotPartitionExists(partitionName) {
        const { rows } = await this.pool.query(`SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`, [partitionName]);
        return rows.length > 0;
    }
    async detachFromHot(partitionName) {
        await this.pool.query(`ALTER TABLE public.${this.tableName} DETACH PARTITION public.${partitionName}`);
    }
    async attachToWarm(partitionName, blockFrom, blockTo) {
        await this.pool.query(`ALTER TABLE archive.${this.tableName} ATTACH PARTITION public.${partitionName}
       FOR VALUES FROM (${blockFrom}) TO (${blockTo})`);
    }
    async warmPartitionExists(partitionName) {
        const { rows } = await this.pool.query(`SELECT 1 FROM pg_class c
       JOIN pg_inherits i ON c.oid = i.inhrelid
       JOIN pg_class p ON i.inhparent = p.oid
       JOIN pg_namespace n ON p.relnamespace = n.oid
       WHERE n.nspname = 'archive' AND p.relname = $1 AND c.relname = $2`, [this.tableName, partitionName]);
        return rows.length > 0;
    }
}
//# sourceMappingURL=partition-repo.js.map