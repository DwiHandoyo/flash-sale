import type { Order } from '@flash-sale/shared/order';
import { describe, expect, it } from 'vitest';

import { percentile, timeline } from '../src/stats';
import { checkRun, type RunFacts } from '../src/verify';

const STARTS_AT = 1_000_000;
const order = (i: number): Order => ({
  orderId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  userId: `user-${i}`,
  purchasedAt: STARTS_AT + i,
});

/** A clean run: 3 units, 10 users, everything saved and consistent. */
function cleanRun(): RunFacts {
  const orders = [order(1), order(2), order(3)];
  return {
    users: 10,
    expectSoldOut: true,
    load: {
      winners: Object.fromEntries(orders.map((o) => [o.userId, o.orderId])),
      conflictingOrders: [],
    },
    sale: { totalStock: 3, soldCount: 3, startsAt: STARTS_AT, endsAt: STARTS_AT + 60_000 },
    redis: { remainingStock: 0, buyers: orders },
    orders,
    queues: { orders: 0, deadLetters: 0 },
  };
}

const failed = (facts: RunFacts) =>
  checkRun(facts)
    .filter((check) => !check.passed)
    .map((check) => check.name);

describe('checkRun', () => {
  it('passes every check for a clean run', () => {
    expect(failed(cleanRun())).toEqual([]);
  });

  it('catches an oversell', () => {
    const run = cleanRun();
    const orders = [...run.orders, order(4)];

    expect(failed({ ...run, orders, sale: { ...run.sale, soldCount: 4 } })).toContain(
      'Exactly min(stock, users) units sold',
    );
  });

  it('catches unsold stock when the whole stock should have sold', () => {
    const run = cleanRun();
    const orders = run.orders.slice(0, 2);

    expect(failed({ ...run, orders })).toContain('Exactly min(stock, users) units sold');
    expect(failed({ ...run, orders, expectSoldOut: false })).not.toContain(
      'No more units sold than the stock',
    );
  });

  it('catches a user who was told "you got it" but has no order', () => {
    const run = cleanRun();
    const load = { ...run.load, winners: { ...run.load.winners, 'user-9': order(9).orderId } };

    expect(failed({ ...run, load })).toEqual([
      'Every "you got it" answer has its order in PostgreSQL',
    ]);
  });

  it('catches a user who was given two different orders', () => {
    const run = cleanRun();

    expect(failed({ ...run, load: { ...run.load, conflictingOrders: ['user-1'] } })).toEqual([
      'At most one order per user',
    ]);
  });

  it('catches Redis and PostgreSQL disagreeing, and lost stock', () => {
    const run = cleanRun();
    const buyers = [order(1), order(2), order(7)];

    expect(failed({ ...run, redis: { remainingStock: 1, buyers } })).toEqual([
      'remainingStock + buyers = totalStock',
      'Redis buyers and PostgreSQL orders match',
    ]);
  });

  it('catches orders outside the sale window and messages left in the queues', () => {
    const run = cleanRun();
    const late = { ...order(3), purchasedAt: run.sale.endsAt };

    expect(
      failed({
        ...run,
        orders: [order(1), order(2), late],
        redis: { remainingStock: 0, buyers: [order(1), order(2), late] },
        queues: { orders: 0, deadLetters: 1 },
      }),
    ).toEqual([
      'Every order falls inside the sale window',
      'Order queue drained, dead-letter queue empty',
    ]);
  });
});

describe('stats', () => {
  it('takes the nearest-rank percentile', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);

    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });

  it('groups outcomes by the second the request was sent in', () => {
    expect(
      timeline([
        { sentAt: 10, latencyMs: 5, outcome: '201 purchased' },
        { sentAt: 999, latencyMs: 5, outcome: '409 sold_out' },
        { sentAt: 2_500, latencyMs: 5, outcome: '409 sold_out' },
      ]),
    ).toEqual([
      { second: 0, outcomes: { '201 purchased': 1, '409 sold_out': 1 } },
      { second: 1, outcomes: {} },
      { second: 2, outcomes: { '409 sold_out': 1 } },
    ]);
  });
});
