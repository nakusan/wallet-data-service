import type { Pool } from 'pg';

export class ManifestRepo {
  constructor(private readonly pool: Pool) {}

  async recordMove(params: {
    chainId: number;
    tableName: string;
    partitionName: string;
    blockFrom: bigint;
    blockTo: bigint;
    rowCount: bigint | null;
    notes?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO archive_manifest
         (chain_id, table_name, partition_name, block_from, block_to, row_count, storage_tier, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'warm',$7)
       ON CONFLICT (partition_name) DO NOTHING`,
      [
        params.chainId,
        params.tableName,
        params.partitionName,
        params.blockFrom.toString(),
        params.blockTo.toString(),
        params.rowCount?.toString() ?? null,
        params.notes ?? null,
      ],
    );
  }
}
