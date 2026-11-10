import pino from 'pino';
import type { Env } from '../../config/env.schema.js';

/** Build the runtime logger with secrets and common personal data removed. */
export function createLogger(level: Env['LOG_LEVEL']): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'authorization',
        'password',
        'token',
        'secret',
        'email',
        'phone',
        'address',
        'deliveryCode',
        'body',
        'req.body',
        'webhookBody',
        '*.authorization',
        '*.password',
        '*.token',
        '*.secret',
        '*.email',
        '*.phone',
        '*.address',
        '*.deliveryCode',
      ],
      censor: '[REDACTED]',
    },
  });
}

/** Keep Nest framework messages on the same structured sink as HTTP. */
export function createNestLogger(logger: pino.Logger): import('@nestjs/common').LoggerService {
  const safe = (message: unknown): string =>
    typeof message === 'string' ? message : '[structured message omitted]';
  return {
    log(message: unknown, context?: string): void {
      logger.info({ context }, safe(message));
    },
    error(message: unknown, _stack?: string, context?: string): void {
      logger.error({ context }, safe(message));
    },
    warn(message: unknown, context?: string): void {
      logger.warn({ context }, safe(message));
    },
    debug(message: unknown, context?: string): void {
      logger.debug({ context }, safe(message));
    },
    verbose(message: unknown, context?: string): void {
      logger.trace({ context }, safe(message));
    },
  };
}
