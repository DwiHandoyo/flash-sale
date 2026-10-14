import type { Order } from '@flash-sale/shared/order';

import type { PurchaseOutcome } from '../domain/purchase';
import { saleStatusAt, type SaleState, type SaleStatus } from '../domain/sale';
import { normalizeUserId } from '../domain/user-id';
import type { CachedValue } from './cached-value';
import { SaleNotInitializedError } from './errors';
import type { OrderPublisher, SaleStore } from './ports';

export interface UseCaseDependencies {
  readonly saleId: string;
  readonly saleStore: SaleStore;
  readonly publisher: OrderPublisher;
  /** A short-lived cache of the sale state (see CachedValue). */
  readonly saleState: CachedValue<SaleState | null>;
  readonly clock: () => number;
  readonly newOrderId: () => string;
}

export interface SaleStatusView extends SaleState {
  readonly status: SaleStatus;
  readonly serverTime: number;
}

export interface UseCases {
  getSaleStatus(): Promise<SaleStatusView>;
  purchase(rawUserId: string): Promise<PurchaseOutcome>;
  getPurchase(rawUserId: string): Promise<{ userId: string; order: Order | null }>;
}

export function createUseCases(deps: UseCaseDependencies): UseCases {
  const { saleId, saleStore, publisher, saleState, clock, newOrderId } = deps;
  const publishOrder = (order: Order) => publisher.publish({ ...order, saleId });

  return {
    async getSaleStatus() {
      const state = await saleState.get();
      if (!state) throw new SaleNotInitializedError();

      const now = clock();
      return { ...state, status: saleStatusAt(state, now), serverTime: now };
    },

    async purchase(rawUserId) {
      const userId = normalizeUserId(rawUserId);

      // Nobody can own an order before the sale opens, so "not started" is certain without asking
      // Redis. This absorbs the button-mashing before opening; every other decision is atomic in
      // Redis.
      const state = await saleState.get();
      if (state && !state.paused && clock() < state.startsAt) return { kind: 'not_started' };

      const result = await saleStore.reserve(userId, newOrderId());
      switch (result.kind) {
        case 'reserved':
          // Only a confirmed order is a purchase. If this throws, the reservation stays and is
          // completed later: on the user's retry (below) or by the reconcile job.
          await publishOrder(result.order);
          return { kind: 'purchased', order: result.order };
        case 'already_purchased':
          // Publish again: if the first publish was never confirmed, this completes it. The worker
          // skips duplicates.
          await publishOrder(result.order);
          return result;
        default:
          return result;
      }
    },

    async getPurchase(rawUserId) {
      const userId = normalizeUserId(rawUserId);
      return { userId, order: await saleStore.findOrder(userId) };
    },
  };
}
