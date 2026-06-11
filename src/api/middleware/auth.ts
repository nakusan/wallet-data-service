import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { loadEnv } from '../../config/env.js';

export interface JwtPayload {
  sub: string;        // api_key id
  scopes: string[];
  rateLimit: number;
  jti: string;
  iat?: number;
  exp?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyId?: string;
      jwtPayload?: JwtPayload;
    }
  }
}

function readBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

export async function isTokenRevoked(redis: Redis, jti: string): Promise<boolean> {
  return (await redis.exists(CacheKeys.jwtRevoked(jti))) === 1;
}

export async function revokeToken(redis: Redis, payload: JwtPayload): Promise<void> {
  const env = loadEnv();
  const ttl = payload.exp
    ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000))
    : env.JWT_TTL_SECONDS;
  await redis.set(CacheKeys.jwtRevoked(payload.jti), '1', 'EX', ttl);
}

/** 仅校验 JWT 签名与黑名单，不校验 scope / 限流 */
export function jwtAuthMiddleware(redis: Redis) {
  const env = loadEnv();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    if (await isTokenRevoked(redis, payload.jti)) {
      res.status(401).json({ error: 'token_revoked' });
      return;
    }

    req.apiKeyId = payload.sub;
    req.jwtPayload = payload;
    next();
  };
}

export function authMiddleware(
  requiredScopes: string[],
  redis: Redis,
) {
  const env = loadEnv();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    if (await isTokenRevoked(redis, payload.jti)) {
      res.status(401).json({ error: 'token_revoked' });
      return;
    }

    // Scope 校验
    if (!requiredScopes.every((s) => payload.scopes.includes(s))) {
      res.status(403).json({ error: 'insufficient_scope', required: requiredScopes });
      return;
    }

    // 滑动窗口限流（每分钟）
    const window = Math.floor(Date.now() / 60_000);
    const ratKey = `rate:${payload.sub}:${window}`;
    const count = await redis.incr(ratKey);
    if (count === 1) await redis.expire(ratKey, 60);
    if (count > payload.rateLimit) {
      res.status(429).json({ error: 'rate_limit_exceeded' });
      return;
    }

    req.apiKeyId = payload.sub;
    next();
  };
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export async function createToken(pool: Pool, rawKey: string): Promise<string | null> {
  const env = loadEnv();
  const keyHash = hashApiKey(rawKey);

  const { rows } = await pool.query(
    `SELECT id, scopes, rate_limit, expires_at
     FROM api_keys
     WHERE key_hash=$1 AND is_active=true`,
    [keyHash],
  );
  if (rows.length === 0) return null;

  const key = rows[0];
  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;

  const { v4: uuidv4 } = await import('uuid');
  const payload: JwtPayload = {
    sub: String(key.id),
    scopes: key.scopes as string[],
    rateLimit: key.rate_limit as number,
    jti: uuidv4(),
  };

  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_TTL_SECONDS });

  await pool.query(
    `UPDATE api_keys SET last_used_at=NOW() WHERE id=$1`,
    [key.id],
  );

  return token;
}
