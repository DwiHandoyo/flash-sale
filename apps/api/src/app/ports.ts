import type { Order, OrderMessage } from '@flash-sale/shared/order';

import type { ReservationResult } from '../domain/purchase';
import type { SaleState } from '../domain/sale';

/**
 * The live sale. Implementations must evaluate every purchase rule and apply the result as one
 * atomic step. Connectivity problems surface as DependencyUnavailableError.
 */
export interface SaleStore {
  /** Returns null when the sale has not been initialised. */
  getState(): Promise<SaleState | null>;
  /** @throws SaleNotInitializedError */
  reserve(userId: string, orderId: string): Promise<ReservationResult>;
  /** @throws SaleNotInitializedError, SalePausedError */
  findOrder(userId: string): Promise<Order | null>;
}

export interface OrderPublisher {
  /** Resolves once the broker has confirmed the order is stored safely. */
  publish(message: OrderMessage): Promise<void>;
}
