import Redis from 'ioredis';
import { loadEnv } from '../../config/env.js';
let _redis = null;
export function getRedis() {
    if (!_redis) {
        _redis = new Redis(loadEnv().REDIS_URL, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: false,
        });
        _redis.on('error', (err) => {
            console.error('[redis] connection error', err);
        });
    }
    return _redis;
}
function bigIntReplacer(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}
export class CacheService {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async getOrSet(key, ttlSeconds, loader) {
        const cached = await this.redis.get(key);
        if (cached !== null)
            return JSON.parse(cached);
        const value = await loader();
        await this.redis.set(key, JSON.stringify(value, bigIntReplacer), 'EX', ttlSeconds);
        return value;
    }
    async invalidate(...keys) {
        if (keys.length > 0)
            await this.redis.del(...keys);
    }
    async incrementCounter(key, windowSec) {
        const count = await this.redis.incr(key);
        if (count === 1)
            await this.redis.expire(key, windowSec);
        return count;
    }
}
export const CacheKeys = {
    tokenBalances: (chainId, addr) => `bal:${chainId}:${addr.toLowerCase()}`,
    nftHoldings: (chainId, addr) => `nft:${chainId}:${addr.toLowerCase()}`,
    topHolders: (chainId, contract, n) => `holders:${chainId}:${contract.toLowerCase()}:${n}`,
    nativeBalance: (chainId, addr) => `native:${chainId}:${addr.toLowerCase()}`,
    jwtRevoked: (jti) => `jwt:revoked:${jti}`,
};
//# sourceMappingURL=redis-client.js.map