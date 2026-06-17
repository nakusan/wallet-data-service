import pino from 'pino';
import { loadEnv } from '../../config/env.js';

function createLogger(): pino.Logger {
  const env = loadEnv();
  const options: pino.LoggerOptions = {
    level: env.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (env.LOG_FILE) {
    return pino(
      options,
      pino.multistream([
        { stream: process.stdout },
        {
          stream: pino.destination({
            dest: env.LOG_FILE,
            mkdir: true,
            sync: false,
          }),
        },
      ]),
    );
  }

  return pino(options);
}

export const logger = createLogger();
