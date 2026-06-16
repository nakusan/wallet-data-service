import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { CacheService, CacheKeys } from '../../infrastructure/cache/redis-client.js';
import { assertChainId } from '../util/assert-chain-id.js';
const addrSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export function nftsRouter(balanceService, redis, configuredChainId) {
    const router = Router();
    const cache = new CacheService(redis);
    const querySchema = z.object({
        chainId: z.coerce.number().int().positive().default(configuredChainId),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
    });
    router.get('/address/:addr/nfts', authMiddleware(['read:balance'], redis), async (req, res, next) => {
        try {
            const addr = addrSchema.parse(req.params.addr);
            const { chainId, limit, offset } = querySchema.parse(req.query);
            assertChainId(chainId, configuredChainId);
            const cacheKey = `${CacheKeys.nftHoldings(chainId, addr)}:${offset}:${limit}`;
            const result = await cache.getOrSet(cacheKey, 60, () => balanceService.getNftHoldings(addr, { limit, offset }));
            res.json({ data: result, limit, offset });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=nfts.js.map