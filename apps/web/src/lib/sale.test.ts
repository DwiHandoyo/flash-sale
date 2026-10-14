import { describe, expect, it } from 'vitest';

import type { Sale } from '../api';
import { formatDuration, statusAt } from './sale';

describe('statusAt', () => {
  const sale: Sale = {
    saleId: 'drop',
    status: 'upcoming',
    startsAt: '2026-01-01T10:00:00.000Z',
    endsAt: '2026-01-01T11:00:00.000Z',
    totalStock: 10,
    remainingStock: 10,
    serverTime: '2026-01-01T09:00:00.000Z',
  };
  const at = (iso: string) => Date.parse(iso);

  it('follows the clock instead of the status captured at poll time', () => {
    expect(statusAt(sale, at('2026-01-01T09:59:59.999Z'))).toBe('upcoming');
    expect(statusAt(sale, at('2026-01-01T10:00:00.000Z'))).toBe('active');
    expect(statusAt(sale, at('2026-01-01T11:00:00.000Z'))).toBe('ended');
  });

  it('trusts the server when the sale is paused for recovery', () => {
    expect(statusAt({ ...sale, status: 'paused' }, at('2026-01-01T10:30:00.000Z'))).toBe('paused');
  });

  it('is sold out during the sale once no stock is left', () => {
    expect(statusAt({ ...sale, remainingStock: 0 }, at('2026-01-01T10:30:00.000Z'))).toBe(
      'sold_out',
    );
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '00:00:00'],
    [-5_000, '00:00:00'],
    [999, '00:00:01'],
    [3_725_000, '01:02:05'],
    [2 * 86_400_000 + 1_000, '2d 00:00:01'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
