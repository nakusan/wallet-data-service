import pino from 'pino';
import { loadEnv } from '../../config/env.js';

export const logger = pino({ level: loadEnv().LOG_LEVEL });
