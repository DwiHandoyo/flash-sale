import type { SaleStatus } from '../../domain/sale';

/** A CDN may reuse the response for this many seconds; browsers always revalidate. */
const shared = (seconds: number) => `public, max-age=0, s-maxage=${seconds}`;
const NO_STORE = 'no-store';

/**
 * How long a CDN may reuse a sale status response (docs/07, D16). The time follows how soon the
 * answer is likely to change. CloudFront follows it in production, and nginx does locally.
 *
 * - Before the opening: 1 s. The app unlocks the buy button from `serverTime`, so an older copy
 *   would unlock it later for some users than for others.
 * - While selling: longer while plenty is left, then not cached at all, so the last units are
 *   shown as they go.
 * - Sold out or ended: the answer no longer changes.
 * - Paused for recovery: not cached, so the sale reopens for everyone at once.
 */
export function saleStatusCacheControl(sale: {
  status: SaleStatus;
  totalStock: number;
  remainingStock: number;
}): string {
  switch (sale.status) {
    case 'upcoming':
      return shared(1);
    case 'sold_out':
    case 'ended':
      return shared(30);
    case 'paused':
      return NO_STORE;
    case 'active': {
      const left = sale.remainingStock / sale.totalStock;
      if (left > 0.8) return shared(5);
      if (left > 0.4) return shared(3);
      if (left > 0.2) return shared(1);
      return NO_STORE;
    }
  }
}
