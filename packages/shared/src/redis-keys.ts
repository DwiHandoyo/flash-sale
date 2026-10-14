import type { Order } from './order';

/**
 * Redis keys of one sale. The `{saleId}` hash tag keeps them on the same Redis Cluster node,
 * which the purchase script needs because it touches both keys in one atomic step.
 */
export function saleKeys(saleId: string) {
  const prefix = `flash-sale:{${saleId}}`;
  return {
    /** Hash with the fields in SALE_FIELDS. */
    sale: `${prefix}:sale`,
    /** Hash: userId → buyer record (see encodeBuyerRecord). */
    buyers: `${prefix}:buyers`,
  } as const;
}

export const SALE_FIELDS = {
  startsAt: 'startsAt',
  endsAt: 'endsAt',
  totalStock: 'totalStock',
  remainingStock: 'remainingStock',
  /** Present only while the sale is paused for recovery. */
  paused: 'paused',
} as const;

/** The buyer record stored per user: JSON, so it is readable in redis-cli. */
export function encodeBuyerRecord(order: Order): string {
  return JSON.stringify({ orderId: order.orderId, purchasedAt: order.purchasedAt });
}

export function decodeBuyerRecord(userId: string, record: string): Order {
  const { orderId, purchasedAt } = JSON.parse(record) as { orderId: string; purchasedAt: number };
  return { orderId, userId, purchasedAt };
}
