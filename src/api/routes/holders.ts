import { Router } from 'express';
import { z } from 'zod';
import type Redis from 'ioredis';
import { authMiddleware } from '../middleware/auth.js';
import type { HoldersService } from '../../wallet/holders-service.js';

const querySchema = z.object({
  chainId: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const contractSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export function holdersRouter(holdersService: HoldersService, redis: Redis): Router {
  const router = Router();

  router.get('/tokens/:contract/holders',
    authMiddleware(['read:holders'], redis),
    async (req, res, next) => {
      try {
        const contract = contractSchema.parse(req.params.contract);
        const { limit } = querySchema.parse(req.query);

        const holders = await holdersService.getTopHolders(contract, limit);
        res.json({ data: holders, total: holders.length });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
