import type { Order, OrderMessage } from '@flash-sale/shared/order';
import { describe, expect, it } from 'vitest';

import { createSaveOrders, type OrderStore } from '../../src/app/save-orders';

/** Remembers saved orders by ID, like the real table with its primary key. */
class InMemoryOrderStore implements OrderStore {
  readonly saved = new Map<string, Order & { saleId: string }>();
  calls: { saleId: string; count: number }[] = [];

  async saveOrders(saleId: string, orders: readonly Order[]): Promise<number> {
    this.calls.push({ saleId, count: orders.length });
    let inserted = 0;
    for (const order of orders) {
      if (this.saved.has(order.orderId)) continue;
      this.saved.set(order.orderId, { ...order, saleId });
      inserted += 1;
    }
    return inserted;
  }
}

const message = (orderId: string, saleId = 'drop'): OrderMessage => ({
  orderId,
  saleId,
  userId: `user-of-${orderId}`,
  purchasedAt: 1_767_225_600_000,
});

describe('saveOrders', () => {
  it('saves new orders and reports how many were new', async () => {
    const store = new InMemoryOrderStore();

    const result = await createSaveOrders(store)([message('a'), message('b')]);

    expect(result).toEqual({ saved: 2, skipped: 0 });
    expect([...store.saved.keys()]).toEqual(['a', 'b']);
  });

  it('counts redelivered orders as skipped', async () => {
    const store = new InMemoryOrderStore();
    const saveOrders = createSaveOrders(store);
    await saveOrders([message('a')]);

    await expect(saveOrders([message('a'), message('b')])).resolves.toEqual({
      saved: 1,
      skipped: 1,
    });
  });

  it('collapses a re-published order that arrives in the same batch', async () => {
    const store = new InMemoryOrderStore();

    const result = await createSaveOrders(store)([message('a'), message('a')]);

    expect(result).toEqual({ saved: 1, skipped: 1 });
    expect(store.calls).toEqual([{ saleId: 'drop', count: 1 }]);
  });

  it('saves the orders of each sale under that sale', async () => {
    const store = new InMemoryOrderStore();

    await createSaveOrders(store)([message('a', 'one'), message('b', 'two'), message('c', 'one')]);

    expect(store.calls).toEqual([
      { saleId: 'one', count: 2 },
      { saleId: 'two', count: 1 },
    ]);
  });
});
