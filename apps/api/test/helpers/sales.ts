import { randomUUID } from 'node:crypto';

import type { SaleDefinition } from '@flash-sale/shared/sale';

export function uniqueSaleId(prefix = 'test'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Opened a minute ago, closes in a minute. Relative times work with any clock, including Redis's. */
export function activeSale(overrides: Partial<SaleDefinition> = {}): SaleDefinition {
  const now = Date.now();
  return {
    id: uniqueSaleId(),
    totalStock: 5,
    startsAt: now - 60_000,
    endsAt: now + 60_000,
    ...overrides,
  };
}

export function upcomingSale(overrides: Partial<SaleDefinition> = {}): SaleDefinition {
  const now = Date.now();
  return activeSale({ startsAt: now + 60_000, endsAt: now + 120_000, ...overrides });
}

export function endedSale(overrides: Partial<SaleDefinition> = {}): SaleDefinition {
  const now = Date.now();
  return activeSale({ startsAt: now - 120_000, endsAt: now - 60_000, ...overrides });
}

export function users(count: number, prefix = 'user'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}
