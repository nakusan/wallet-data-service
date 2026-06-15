import { ZodError } from 'zod';
import { logger } from '../../infrastructure/logger/logger.js';
function isPoolOrStatementTimeout(err) {
    if (!(err instanceof Error))
        return false;
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout exceeded when trying to connect'))
        return true;
    if (msg.includes('statement timeout'))
        return true;
    const code = err.code;
    return code === '57014';
}
export function errorHandler(err, req, res, _next) {
    if (err instanceof ZodError) {
        res.status(400).json({
            error: 'validation_error',
            details: err.flatten().fieldErrors,
        });
        return;
    }
    if (isPoolOrStatementTimeout(err)) {
        logger.warn({ err, method: req.method, path: req.path }, 'Database timeout');
        res.status(503).json({ error: 'service_unavailable' });
        return;
    }
    logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
    res.status(500).json({ error: 'internal_server_error' });
}
//# sourceMappingURL=error-handler.js.map