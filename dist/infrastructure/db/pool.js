import pg from 'pg';
export function createPool(databaseUrl, maxConnections = 10) {
    return new pg.Pool({ connectionString: databaseUrl, max: maxConnections });
}
//# sourceMappingURL=pool.js.map