import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { loadEnv } from '../../config/env.js';
export function authMiddleware(requiredScopes, redis) {
    const env = loadEnv();
    return async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'missing_token' });
            return;
        }
        const token = authHeader.slice(7);
        let payload;
        try {
            payload = jwt.verify(token, env.JWT_SECRET);
        }
        catch {
            res.status(401).json({ error: 'invalid_token' });
            return;
        }
        // JWT 黑名单检查（注销后的 token）
        const revoked = await redis.sismember(CacheKeys.jwtRevoked, payload.jti);
        if (revoked) {
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
        if (count === 1)
            await redis.expire(ratKey, 60);
        if (count > payload.rateLimit) {
            res.status(429).json({ error: 'rate_limit_exceeded' });
            return;
        }
        req.apiKeyId = payload.sub;
        next();
    };
}
export function hashApiKey(rawKey) {
    return createHash('sha256').update(rawKey).digest('hex');
}
export async function createToken(pool, rawKey) {
    const env = loadEnv();
    const keyHash = hashApiKey(rawKey);
    const { rows } = await pool.query(`SELECT id, scopes, rate_limit, expires_at
     FROM api_keys
     WHERE key_hash=$1 AND is_active=true`, [keyHash]);
    if (rows.length === 0)
        return null;
    const key = rows[0];
    if (key.expires_at && new Date(key.expires_at) < new Date())
        return null;
    const { v4: uuidv4 } = await import('uuid');
    const payload = {
        sub: String(key.id),
        scopes: key.scopes,
        rateLimit: key.rate_limit,
        jti: uuidv4(),
    };
    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_TTL_SECONDS });
    await pool.query(`UPDATE api_keys SET last_used_at=NOW() WHERE id=$1`, [key.id]);
    return token;
}
//# sourceMappingURL=auth.js.map