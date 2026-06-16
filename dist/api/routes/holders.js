import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { assertChainId } from '../util/assert-chain-id.js';
const contractSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export function holdersRouter(holdersService, redis, configuredChainId) {
    const router = Router();
    const querySchema = z.object({
        chainId: z.coerce.number().int().positive().default(configuredChainId),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    router.get('/tokens/:contract/holders', authMiddleware(['read:holders'], redis), async (req, res, next) => {
        try {
            const contract = contractSchema.parse(req.params.contract);
            const { chainId, limit } = querySchema.parse(req.query);
            assertChainId(chainId, configuredChainId);
            const result = await holdersService.getTopHolders(contract, limit);
            res.json(result);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=holders.js.map