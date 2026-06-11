import Redis from 'ioredis';
import { loadEnv } from '../../config/env.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
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

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export class CacheService {
  constructor(private readonly redis: Redis) {}

  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached !== null) return JSON.parse(cached) as T;

    const value = await loader();
    await this.redis.set(
      key,
      JSON.stringify(value, bigIntReplacer),
      'EX',
      ttlSeconds,
    );
    return value;
  }

  async invalidate(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys);
  }

  async incrementCounter(key: string, windowSec: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSec);
    return count;
  }
}

export const CacheKeys = {
  tokenBalances: (chainId: number, addr: string) =>
    `bal:${chainId}:${addr.toLowerCase()}`,
  nftHoldings: (chainId: number, addr: string) =>
    `nft:${chainId}:${addr.toLowerCase()}`,
  topHolders: (chainId: number, contract: string, n: number) =>
    `holders:${chainId}:${contract.toLowerCase()}:${n}`,
  nativeBalance: (chainId: number, addr: string) =>
    `native:${chainId}:${addr.toLowerCase()}`,
  jwtRevoked: (jti: string) => `jwt:revoked:${jti}`,
} as const;
