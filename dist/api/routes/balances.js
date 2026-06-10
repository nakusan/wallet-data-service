import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { CacheService, CacheKeys } from '../../infrastructure/cache/redis-client.js';
const querySchema = z.object({
    chainId: z.coerce.number().int().positive().default(1),
});
const addrSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export function balancesRouter(balanceService, redis) {
    const router = Router();
    const cache = new CacheService(redis);
    router.get('/address/:addr/balances', authMiddleware(['read:balance'], redis), async (req, res, next) => {
        try {
            const addr = addrSchema.parse(req.params.addr);
            const { chainId } = querySchema.parse(req.query);
            const cacheKey = CacheKeys.tokenBalances(chainId, addr);
            const result = await cache.getOrSet(cacheKey, 30, async () => {
                const [tokens, nfts, native] = await Promise.all([
                    balanceService.getTokenBalances(addr),
                    balanceService.getNftHoldings(addr, { limit: 50 }),
                    balanceService.getNativeBalance(addr),
                ]);
                return { native, tokens, nfts };
            });
            res.json(result);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=balances.js.map