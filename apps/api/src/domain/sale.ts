import type { SaleDefinition } from '@flash-sale/shared/sale';

/** The sale definition plus its live state in Redis. */
export interface SaleState extends SaleDefinition {
  readonly remainingStock: number;
  /** True while the recovery job has paused the sale. */
  readonly paused: boolean;
}

export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended' | 'paused';

export function saleStatusAt(sale: SaleState, now: number): SaleStatus {
  if (sale.paused) return 'paused';
  if (now < sale.startsAt) return 'upcoming';
  if (now >= sale.endsAt) return 'ended';
  return sale.remainingStock > 0 ? 'active' : 'sold_out';
}
