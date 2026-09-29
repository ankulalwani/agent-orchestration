import pino, { type Logger, type LoggerOptions } from 'pino';
import { redact } from './redact.js';

export type { Logger };

/**
 * Structured JSON logger (spec §61) with secret redaction applied to every log object and message
 * (spec §59). Pretty output is left to external tools (`pino-pretty`) to keep production lean.
 */
export function createLogger(name: string, opts: LoggerOptions = {}): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((a) => redact(a)) as Parameters<typeof method>);
      },
    },
    ...opts,
  });
}
