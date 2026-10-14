import { ConfigError } from '@flash-sale/shared/config';
import { describe, expect, it } from 'vitest';

import { loadSaleDefinition } from '../../src/config';

describe('loadSaleDefinition', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('opens 30 seconds after boot and runs for an hour by default', () => {
    expect(loadSaleDefinition({}, now)).toEqual({
      id: 'limited-edition-drop',
      totalStock: 100,
      startsAt: now + 30_000,
      endsAt: now + 30_000 + 3_600_000,
    });
  });

  it('supports relative timings', () => {
    const sale = loadSaleDefinition(
      { SALE_START_DELAY_SECONDS: '0', SALE_DURATION_SECONDS: '60', SALE_TOTAL_STOCK: '5' },
      now,
    );

    expect(sale).toMatchObject({ totalStock: 5, startsAt: now, endsAt: now + 60_000 });
  });

  it('prefers absolute timestamps', () => {
    const sale = loadSaleDefinition(
      { SALE_STARTS_AT: '2026-02-01T10:00:00Z', SALE_ENDS_AT: '2026-02-01T11:00:00Z' },
      now,
    );

    expect(sale.startsAt).toBe(Date.parse('2026-02-01T10:00:00Z'));
    expect(sale.endsAt).toBe(Date.parse('2026-02-01T11:00:00Z'));
  });

  it.each([
    [
      'a window that ends before it starts',
      { SALE_STARTS_AT: '2026-02-01T11:00:00Z', SALE_ENDS_AT: '2026-02-01T10:00:00Z' },
    ],
    ['a malformed timestamp', { SALE_STARTS_AT: 'tomorrow' }],
    ['negative stock', { SALE_TOTAL_STOCK: '-1' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadSaleDefinition(env, now)).toThrow(ConfigError);
  });
});
