import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../infrastructure/logger/logger.js';
import { UnsupportedChainError } from '../util/assert-chain-id.js';

function isPoolOrStatementTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes('timeout exceeded when trying to connect')) return true;
  if (msg.includes('statement timeout')) return true;
  const code = (err as NodeJS.ErrnoException & { code?: string }).code;
  return code === '57014';
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_error',
      details: err.flatten().fieldErrors,
    });
    return;
  }

  if (err instanceof UnsupportedChainError) {
    res.status(400).json({
      error: err.code,
      message: err.message,
      configuredChainId: err.configured,
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
