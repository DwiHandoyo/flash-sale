import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs on stdout, so any log collector can read them. */
export function createLogger(name: string, level = 'info'): Logger {
  return pino({ name, level });
}
