import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { loadEnv } from '../../config/env.js';
import {
  createToken,
  jwtAuthMiddleware,
  revokeToken,
} from '../middleware/auth.js';

const tokenSchema = z.object({ apiKey: z.string().min(1) });

export function authRouter(pool: Pool, redis: Redis): Router {
  const router = Router();
  const env = loadEnv();

  router.post('/token', async (req, res, next) => {
    try {
      const { apiKey } = tokenSchema.parse(req.body);
      const token = await createToken(pool, apiKey);
      if (!token) {
        res.status(401).json({ error: 'invalid_api_key' });
        return;
      }
      res.json({ token, ttl: env.JWT_TTL_SECONDS });
    } catch (err) {
      next(err);
    }
  });

  router.post('/revoke', jwtAuthMiddleware(redis), async (req, res, next) => {
    try {
      const payload = req.jwtPayload;
      if (!payload) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      await revokeToken(redis, payload);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
