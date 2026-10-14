import type { Order, OrderMessage } from '@flash-sale/shared/order';

/** Where orders are saved for good (PostgreSQL in production). */
export interface OrderStore {
  /**
   * Saves orders idempotently and returns how many were new.
   * @throws OrderRejectedError when the data itself is refused (retrying cannot help)
   * @throws DependencyUnavailableError when the store cannot be reached (retry later)
   */
  saveOrders(saleId: string, orders: readonly Order[]): Promise<number>;
}

export interface SaveResult {
  readonly saved: number;
  /** Orders that were already saved: redeliveries and re-publishes. */
  readonly skipped: number;
}

/**
 * The worker's one job, independent of where the messages come from. A RabbitMQ consumer calls
 * it locally; in production a Lambda handler would call the same function.
 */
export function createSaveOrders(store: OrderStore) {
  return async function saveOrders(messages: readonly OrderMessage[]): Promise<SaveResult> {
    // A re-published order can arrive in the same batch as the original.
    const unique = new Map(messages.map((message) => [message.orderId, message]));

    const bySale = new Map<string, Order[]>();
    for (const { saleId, orderId, userId, purchasedAt } of unique.values()) {
      const orders = bySale.get(saleId) ?? [];
      orders.push({ orderId, userId, purchasedAt });
      bySale.set(saleId, orders);
    }

    let saved = 0;
    for (const [saleId, orders] of bySale) saved += await store.saveOrders(saleId, orders);
    return { saved, skipped: messages.length - saved };
  };
}
