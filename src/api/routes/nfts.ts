import { Router } from 'express';
import { z } from 'zod';
import type Redis from 'ioredis';
import { authMiddleware } from '../middleware/auth.js';
import type { BalanceService } from '../../wallet/service/balance-service.js';
import { CacheService, CacheKeys } from '../../infrastructure/cache/redis-client.js';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const addrSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export function nftsRouter(balanceService: BalanceService, redis: Redis): Router {
  const router = Router();
  const cache = new CacheService(redis);

  router.get('/address/:addr/nfts',
    authMiddleware(['read:balance'], redis),
    async (req, res, next) => {
      try {
        const addr = addrSchema.parse(req.params.addr);
        const { chainId, limit, offset } = querySchema.parse(req.query);
        const cacheKey = `${CacheKeys.nftHoldings(chainId, addr)}:${offset}:${limit}`;

        const result = await cache.getOrSet(cacheKey, 60, () =>
          balanceService.getNftHoldings(addr, { limit, offset }),
        );
        res.json({ data: result, limit, offset });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
