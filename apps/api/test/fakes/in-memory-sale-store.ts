import type { Order } from '@flash-sale/shared/order';
import type { SaleDefinition } from '@flash-sale/shared/sale';

import { SaleNotInitializedError, SalePausedError } from '../../src/app/errors';
import type { SaleStore } from '../../src/app/ports';
import type { ReservationResult } from '../../src/domain/purchase';
import type { SaleState } from '../../src/domain/sale';

/**
 * Test double for the Redis store. It applies the same rules in the same order as the reserve
 * script; the shared contract tests keep the two in line. `reserve` runs synchronously between
 * awaits, so it is atomic within this process.
 */
export class InMemorySaleStore implements SaleStore {
  private remainingStock: number;
  private readonly buyers = new Map<string, Order>();

  constructor(
    private readonly sale: SaleDefinition | null,
    private paused = false,
    private readonly clock: () => number = Date.now,
  ) {
    this.remainingStock = sale?.totalStock ?? 0;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async getState(): Promise<SaleState | null> {
    if (!this.sale) return null;
    return { ...this.sale, remainingStock: this.remainingStock, paused: this.paused };
  }

  async reserve(userId: string, orderId: string): Promise<ReservationResult> {
    return this.tryReserve(userId, orderId);
  }

  async findOrder(userId: string): Promise<Order | null> {
    if (!this.sale) throw new SaleNotInitializedError();
    if (this.paused) throw new SalePausedError();
    return this.buyers.get(userId) ?? null;
  }

  private tryReserve(userId: string, orderId: string): ReservationResult {
    const sale = this.sale;
    if (!sale) throw new SaleNotInitializedError();
    if (this.paused) return { kind: 'paused' };

    const existing = this.buyers.get(userId);
    if (existing) return { kind: 'already_purchased', order: existing };

    const now = this.clock();
    if (now < sale.startsAt) return { kind: 'not_started' };
    if (now >= sale.endsAt) return { kind: 'ended' };
    if (this.remainingStock <= 0) return { kind: 'sold_out' };

    const order: Order = { orderId, userId, purchasedAt: now };
    this.remainingStock -= 1;
    this.buyers.set(userId, order);
    return { kind: 'reserved', order };
  }
}
