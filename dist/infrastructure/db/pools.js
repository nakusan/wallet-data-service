import { createPool } from './pool.js';
export function createDbPools(config) {
    const common = {
        connectionTimeoutMillis: config.connectionTimeoutMillis,
        idleTimeoutMillis: config.idleTimeoutMillis,
    };
    return {
        api: createPool(config.databaseUrl, {
            ...common,
            max: config.apiMax,
            application_name: 'wds-api',
            statementTimeoutMs: config.apiStatementTimeoutMs,
        }),
        worker: createPool(config.databaseUrl, {
            ...common,
            max: config.workerMax,
            application_name: 'wds-worker',
            statementTimeoutMs: config.workerStatementTimeoutMs,
        }),
    };
}
//# sourceMappingURL=pools.js.map