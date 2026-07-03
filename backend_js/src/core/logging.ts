import winston from 'winston';
import { getSettings } from '../config/settings.js';

const settings = getSettings();

const getLogLevel = () => {
  const level = settings.log_level.toLowerCase();
  if (level === 'critical') return 'error'; // Map critical to error in winston
  return level;
};

const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message, requestId, ...meta }) => {
    const reqStr = requestId ? ` [Req ID: ${requestId}]` : '';
    const metaStr = Object.keys(meta).length ? ` | Meta: ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}${reqStr}: ${message}${metaStr}`;
  })
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: getLogLevel(),
  format: settings.environment === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console({
      silent: settings.environment === 'test',
    }),
  ],
});

// Provide compatibility functions mapping Python logging
export const logInfo = (msg: string, meta?: any) => logger.info(msg, meta);
export const logError = (msg: string, err?: any) => {
  if (err instanceof Error) {
    logger.error(msg, { error_message: err.message, stack: err.stack });
  } else {
    logger.error(msg, { error: err });
  }
};
export const logWarn = (msg: string, meta?: any) => logger.warn(msg, meta);
export const logDebug = (msg: string, meta?: any) => logger.debug(msg, meta);
