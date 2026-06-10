import { Router } from 'express';
import { z } from 'zod';
import { createToken } from '../middleware/auth.js';
const tokenSchema = z.object({ apiKey: z.string().min(1) });
export function authRouter(pool) {
    const router = Router();
    router.post('/token', async (req, res, next) => {
        try {
            const { apiKey } = tokenSchema.parse(req.body);
            const token = await createToken(pool, apiKey);
            if (!token) {
                res.status(401).json({ error: 'invalid_api_key' });
                return;
            }
            res.json({ token, ttl: 3600 });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=auth.js.map