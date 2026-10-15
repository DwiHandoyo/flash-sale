import { describe, expect, it } from 'vitest';

import { saleStatusCacheControl } from '../../src/adapters/http/cache-control';
import type { SaleStatus } from '../../src/domain/sale';

const header = (status: SaleStatus, remainingStock = 0, totalStock = 100) =>
  saleStatusCacheControl({ status, totalStock, remainingStock });

describe('saleStatusCacheControl', () => {
  it.each([
    [100, 'public, max-age=0, s-maxage=5'],
    [81, 'public, max-age=0, s-maxage=5'],
    [80, 'public, max-age=0, s-maxage=3'],
    [41, 'public, max-age=0, s-maxage=3'],
    [40, 'public, max-age=0, s-maxage=1'],
    [21, 'public, max-age=0, s-maxage=1'],
    [20, 'no-store'],
    [1, 'no-store'],
  ])('while selling with %i of 100 units left: %s', (left, expected) => {
    expect(header('active', left)).toBe(expected);
  });

  it('keeps one second before the opening, when the buy button unlocks from serverTime', () => {
    expect(header('upcoming', 100)).toBe('public, max-age=0, s-maxage=1');
  });

  it('caches the final states longer, because they no longer change', () => {
    expect(header('sold_out')).toBe('public, max-age=0, s-maxage=30');
    expect(header('ended', 7)).toBe('public, max-age=0, s-maxage=30');
  });

  it('never caches a paused sale, so it reopens for everyone at once', () => {
    expect(header('paused', 50)).toBe('no-store');
  });
});
