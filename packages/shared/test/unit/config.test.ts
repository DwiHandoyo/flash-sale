import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  readBoolean,
  readInt,
  readSaleId,
  readServiceUrl,
  readString,
  readTimestamp,
} from '../../src/config';

describe('config helpers', () => {
  it('fall back to defaults when a variable is missing or empty', () => {
    expect(readString({}, 'A', 'x')).toBe('x');
    expect(readInt({ N: '' }, 'N', 5)).toBe(5);
    expect(readBoolean({}, 'B', true)).toBe(true);
    expect(readTimestamp({}, 'T')).toBeUndefined();
  });

  it('parse valid values', () => {
    expect(readInt({ N: '42' }, 'N', 0, { min: 1, max: 100 })).toBe(42);
    expect(readBoolean({ B: 'false' }, 'B', true)).toBe(false);
    expect(readTimestamp({ T: '2026-01-01T00:00:00Z' }, 'T')).toBe(
      Date.parse('2026-01-01T00:00:00Z'),
    );
  });

  it.each([
    ['a required variable that is missing', () => readString({}, 'REQUIRED')],
    ['a non-integer', () => readInt({ N: '1.5' }, 'N', 0)],
    ['an integer out of range', () => readInt({ N: '70000' }, 'N', 0, { max: 65_535 })],
    ['a non-boolean', () => readBoolean({ B: 'yes' }, 'B', false)],
    ['an unparseable date', () => readTimestamp({ T: 'tomorrow' }, 'T')],
    ['a malformed URL', () => readServiceUrl({ U: 'not a url' }, 'U', 'U_PASSWORD', 'redis://x')],
    ['a sale ID that would break the Redis hash tag', () => readSaleId({ SALE_ID: 'drop}{' })],
  ])('reject %s', (_label, read) => {
    expect(read).toThrow(ConfigError);
  });
});

describe('readServiceUrl', () => {
  it('uses the URL as given when no separate password is set', () => {
    const url = readServiceUrl(
      { REDIS_URL: 'redis://localhost:16379' },
      'REDIS_URL',
      'REDIS_PASSWORD',
      'x',
    );

    expect(url).toBe('redis://localhost:16379');
  });

  it('puts a separately supplied password into the URL, encoded', () => {
    const url = readServiceUrl(
      { RABBITMQ_URL: 'amqps://flash-sale@broker:5671', RABBITMQ_PASSWORD: 'p@ss:word/1' },
      'RABBITMQ_URL',
      'RABBITMQ_PASSWORD',
      'x',
    );

    expect(url).toBe('amqps://flash-sale:p%40ss%3Aword%2F1@broker:5671');
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss:word/1');
  });
});
