import pino from 'pino';

const isPretty = process.env.LOG_PRETTY === 'true';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isPretty && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: true,
      },
    },
  }),
});

export const logInfo = (message: string): void => logger.info(message);
export const logWarn = (message: string): void => logger.warn(message);
export const logError = (message: string): void => logger.error(message);
export const logDebug = (message: string): void => logger.debug(message);