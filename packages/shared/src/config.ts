/**
 * Helpers for reading configuration from environment variables. Every app reads and validates
 * its configuration once at start-up and refuses to start when something is wrong.
 */
import { isValidSaleId } from './sale';

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function readString(env: Env, name: string, fallback?: string): string {
  const raw = env[name];
  if (raw !== undefined && raw !== '') return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${name} is required.`);
}

export function readInt(
  env: Env,
  name: string,
  fallback: number,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}".`);
  }
  return value;
}

export function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}".`);
}

/** An ISO 8601 date as epoch milliseconds, or undefined when the variable is not set. */
export function readTimestamp(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;

  const value = Date.parse(raw);
  if (Number.isNaN(value)) throw new ConfigError(`${name} must be an ISO 8601 date, got "${raw}".`);
  return value;
}

/**
 * A connection URL. If `passwordName` is set (as in production, where passwords come from a
 * secret store as separate variables), that password is put into the URL.
 */
export function readServiceUrl(
  env: Env,
  name: string,
  passwordName: string,
  fallback: string,
): string {
  const raw = readString(env, name, fallback);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a URL, got "${raw}".`);
  }

  const password = env[passwordName];
  if (password) url.password = password; // the URL setter percent-encodes it
  return url.toString();
}

export function readSaleId(env: Env): string {
  const saleId = readString(env, 'SALE_ID', 'limited-edition-drop');
  if (!isValidSaleId(saleId)) {
    throw new ConfigError('SALE_ID may only contain letters, numbers, "-" and "_" (max 64).');
  }
  return saleId;
}
