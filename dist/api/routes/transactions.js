import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { assertChainId } from '../util/assert-chain-id.js';
const addrSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export function transactionsRouter(txService, redis, configuredChainId) {
    const router = Router();
    const querySchema = z.object({
        chainId: z.coerce.number().int().positive().default(configuredChainId),
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
    });
    router.get('/address/:addr/transactions', authMiddleware(['read:tx'], redis), async (req, res, next) => {
        try {
            const addr = addrSchema.parse(req.params.addr);
            const { chainId, token, limit, cursor } = querySchema.parse(req.query);
            assertChainId(chainId, configuredChainId);
            const page = await txService.getHistory(chainId, addr, { token, limit, cursor });
            res.json(page);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=transactions.js.map