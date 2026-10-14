/**
 * The checks after a stress run (docs/09, "Stress test"). They read the data stores directly
 * instead of trusting the API's answers.
 */
import type { Order } from '@flash-sale/shared/order';

import type { LoadResult } from './load-result';

/** Everything the checks look at, read once the workers have saved every order. */
export interface RunFacts {
  readonly users: number;
  /** False when the fault may legitimately leave stock unsold (a wiped Redis, for example). */
  readonly expectSoldOut: boolean;
  readonly load: Pick<LoadResult, 'winners' | 'conflictingOrders'>;
  /** The sale row in PostgreSQL. */
  readonly sale: { totalStock: number; soldCount: number; startsAt: number; endsAt: number };
  readonly redis: { remainingStock: number; buyers: readonly Order[] };
  /** The order rows in PostgreSQL. */
  readonly orders: readonly Order[];
  readonly queues: { orders: number; deadLetters: number };
}

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export function checkRun(facts: RunFacts): Check[] {
  const { users, expectSoldOut, load, sale, redis, orders, queues } = facts;
  const stock = sale.totalStock;
  const expected = Math.min(stock, users);

  const persisted = new Map(orders.map((order) => [order.userId, order.orderId]));
  const winners = Object.entries(load.winners);
  const missing = winners.filter(([userId, orderId]) => persisted.get(userId) !== orderId);
  const inRedisOnly = redis.buyers.filter((buyer) => persisted.get(buyer.userId) !== buyer.orderId);
  const outsideWindow = orders.filter(
    (order) => order.purchasedAt < sale.startsAt || order.purchasedAt >= sale.endsAt,
  );

  return [
    expectSoldOut
      ? {
          name: 'Exactly min(stock, users) units sold',
          passed: orders.length === expected,
          detail: `${orders.length} orders, expected ${expected}`,
        }
      : {
          name: 'No more units sold than the stock',
          passed: orders.length <= stock,
          detail: `${orders.length} orders for ${stock} units`,
        },
    {
      name: 'At most one order per user',
      passed: persisted.size === orders.length && load.conflictingOrders.length === 0,
      detail: `${persisted.size} users hold ${orders.length} orders; ${load.conflictingOrders.length} users were given two different orders`,
    },
    {
      name: 'remainingStock + buyers = totalStock',
      passed: redis.remainingStock + redis.buyers.length === stock,
      detail: `${redis.remainingStock} + ${redis.buyers.length} = ${redis.remainingStock + redis.buyers.length}, totalStock ${stock}`,
    },
    {
      name: 'Every "you got it" answer has its order in PostgreSQL',
      passed: missing.length === 0,
      detail: `${winners.length} users were told they have an item; ${missing.length} of them have no matching order`,
    },
    {
      name: 'Redis buyers and PostgreSQL orders match',
      passed: redis.buyers.length === orders.length && inRedisOnly.length === 0,
      detail: `${redis.buyers.length} buyers in Redis, ${orders.length} orders in PostgreSQL, ${inRedisOnly.length} differ`,
    },
    {
      name: 'sold_count matches the order rows',
      passed: sale.soldCount === orders.length,
      detail: `sold_count ${sale.soldCount}, ${orders.length} rows`,
    },
    {
      name: 'Every order falls inside the sale window',
      passed: outsideWindow.length === 0,
      detail: `${outsideWindow.length} orders outside the window`,
    },
    {
      name: 'Order queue drained, dead-letter queue empty',
      passed: queues.orders === 0 && queues.deadLetters === 0,
      detail: `${queues.orders} waiting, ${queues.deadLetters} dead-lettered`,
    },
  ];
}
