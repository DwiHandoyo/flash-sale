import { randomUUID } from 'node:crypto';

import type { SaleDefinition } from '@flash-sale/shared/sale';
import { describe, expect, it } from 'vitest';

import { SaleNotInitializedError, SalePausedError } from '../../src/app/errors';
import type { SaleStore } from '../../src/app/ports';
import type { ReservationResult } from '../../src/domain/purchase';
import { activeSale, endedSale, upcomingSale, users } from '../helpers/sales';

export interface StoreSetup {
  readonly sale: SaleDefinition | null;
  readonly paused?: boolean;
}

export type SaleStoreFactory = (setup: StoreSetup) => Promise<SaleStore>;

/** Tolerance between the store's clock (Redis) and the test runner's clock. */
const CLOCK_TOLERANCE_MS = 2_000;

const countKind = (results: ReservationResult[], kind: ReservationResult['kind']) =>
  results.filter((result) => result.kind === kind).length;

/**
 * How every SaleStore must behave. The same suite runs against the in-memory test double (unit
 * tests) and the Redis store (integration tests), so the double cannot drift from production.
 */
export function describeSaleStoreContract(name: string, createStore: SaleStoreFactory): void {
  describe(`${name} (SaleStore contract)`, () => {
    it('exposes the sale with full stock before any purchase', async () => {
      const sale = activeSale({ totalStock: 3 });
      const store = await createStore({ sale });

      await expect(store.getState()).resolves.toEqual({
        ...sale,
        remainingStock: 3,
        paused: false,
      });
    });

    it('reports no state when the sale has not been initialised', async () => {
      const store = await createStore({ sale: null });

      await expect(store.getState()).resolves.toBeNull();
      await expect(store.reserve('alice', randomUUID())).rejects.toThrow(SaleNotInitializedError);
      await expect(store.findOrder('alice')).rejects.toThrow(SaleNotInitializedError);
    });

    it('reserves a unit: one less in stock, and the order is recorded', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 3 }) });
      const orderId = randomUUID();

      const result = await store.reserve('alice', orderId);

      expect(result).toMatchObject({ kind: 'reserved', order: { orderId, userId: 'alice' } });
      const { order } = result as Extract<ReservationResult, { kind: 'reserved' }>;
      expect(Math.abs(order.purchasedAt - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
      expect((await store.getState())?.remainingStock).toBe(2);
      await expect(store.findOrder('alice')).resolves.toEqual(order);
    });

    it('returns the original order when the same user tries again', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 3 }) });

      const first = await store.reserve('alice', randomUUID());
      const second = await store.reserve('alice', randomUUID());

      expect(second).toEqual({
        kind: 'already_purchased',
        order: (first as { order: unknown }).order,
      });
      expect((await store.getState())?.remainingStock).toBe(2);
    });

    it('answers sold out once the stock is gone', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 2 }) });

      const results = [];
      for (const userId of users(3)) results.push(await store.reserve(userId, randomUUID()));

      expect(results.map((result) => result.kind)).toEqual(['reserved', 'reserved', 'sold_out']);
      expect((await store.getState())?.remainingStock).toBe(0);
      await expect(store.findOrder('user-2')).resolves.toBeNull();
    });

    it('treats a sale without stock as sold out', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 0 }) });

      await expect(store.reserve('alice', randomUUID())).resolves.toEqual({ kind: 'sold_out' });
    });

    it('rejects purchases before the sale starts', async () => {
      const store = await createStore({ sale: upcomingSale({ totalStock: 3 }) });

      await expect(store.reserve('alice', randomUUID())).resolves.toEqual({ kind: 'not_started' });
      expect((await store.getState())?.remainingStock).toBe(3);
    });

    it('rejects purchases after the sale ends', async () => {
      const store = await createStore({ sale: endedSale({ totalStock: 3 }) });

      await expect(store.reserve('alice', randomUUID())).resolves.toEqual({ kind: 'ended' });
      expect((await store.getState())?.remainingStock).toBe(3);
    });

    it('rejects everything while paused for recovery, including lookups', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 3 }), paused: true });

      await expect(store.getState()).resolves.toMatchObject({ paused: true });
      await expect(store.reserve('alice', randomUUID())).resolves.toEqual({ kind: 'paused' });
      await expect(store.findOrder('alice')).rejects.toThrow(SalePausedError);
      expect((await store.getState())?.remainingStock).toBe(3);
    });

    it('never sells more than the stock under concurrent attempts', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 10 }) });

      const results = await Promise.all(
        users(300).map((userId) => store.reserve(userId, randomUUID())),
      );

      expect(countKind(results, 'reserved')).toBe(10);
      expect(countKind(results, 'sold_out')).toBe(290);
      expect((await store.getState())?.remainingStock).toBe(0);
    });

    it('sells at most one unit per user under concurrent attempts', async () => {
      const store = await createStore({ sale: activeSale({ totalStock: 10 }) });

      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.reserve('eager-buyer', randomUUID())),
      );

      expect(countKind(results, 'reserved')).toBe(1);
      expect(countKind(results, 'already_purchased')).toBe(49);
      const orders = new Set(
        results.map((result) => JSON.stringify((result as { order: unknown }).order)),
      );
      expect(orders.size).toBe(1);
      expect((await store.getState())?.remainingStock).toBe(9);
    });
  });
}
