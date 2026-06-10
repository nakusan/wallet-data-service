import { ZodError } from 'zod';
import { logger } from '../../infrastructure/logger/logger.js';
export function errorHandler(err, req, res, _next) {
    if (err instanceof ZodError) {
        res.status(400).json({
            error: 'validation_error',
            details: err.flatten().fieldErrors,
        });
        return;
    }
    logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
    res.status(500).json({ error: 'internal_server_error' });
}
//# sourceMappingURL=error-handler.js.map