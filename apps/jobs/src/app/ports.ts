import type { Logger } from '@flash-sale/shared/logger';
import type { Order, OrderMessage } from '@flash-sale/shared/order';
import type { OrderRepository, SaleRepository } from '@flash-sale/shared/postgres';
import type { SaleDefinition } from '@flash-sale/shared/sale';

/** The live sale in Redis, as the jobs see it. */
export interface SaleStateStore {
  getState(): Promise<{ remainingStock: number; paused: boolean } | null>;
  listBuyers(): Promise<Order[]>;
  /**
   * Makes Redis consistent with PostgreSQL without losing anything: writes the definition, adds
   * persisted buyers Redis does not know, and recomputes the stock from the union.
   */
  sync(sale: SaleDefinition, persisted: readonly Order[]): Promise<SyncReport>;
  /** Rule 0: from now on, purchases and lookups answer "paused". */
  pause(sale: SaleDefinition): Promise<void>;
  /** Replaces buyers and stock with exactly the given orders. Leaves the sale paused. */
  rebuild(sale: SaleDefinition, orders: readonly Order[]): Promise<void>;
  resume(): Promise<void>;
  /** Wipes the sale and starts it again with full stock (demos and stress tests only). */
  reset(sale: SaleDefinition): Promise<void>;
}

export interface SyncReport {
  readonly buyers: number;
  /** Persisted buyers that Redis had lost and got back. */
  readonly restored: number;
  readonly remainingStock: number;
}

/** The order queues in RabbitMQ. */
export interface QueueAdmin {
  declareTopology(): Promise<void>;
  /**
   * Orders waiting in the queue or held by a worker. The part held by workers comes from sampled
   * statistics, so it can lag a few seconds (see waitUntilDrained); undefined while unknown.
   */
  ordersInFlight(): Promise<number | undefined>;
  deadLetters(): Promise<number>;
  purge(): Promise<void>;
}

export interface OrderPublisher {
  /** Resolves once RabbitMQ has confirmed the message is stored. */
  publish(message: OrderMessage): Promise<void>;
}

export interface JobDependencies {
  readonly saleId: string;
  readonly logger: Logger;
  readonly sales: SaleRepository;
  readonly orders: OrderRepository;
  readonly saleState: SaleStateStore;
  readonly queues: QueueAdmin;
  readonly publisher: OrderPublisher;
  readonly migrate: () => Promise<void>;
  /** Resets the sale row and deletes its orders, in one transaction. */
  readonly resetPersistedSale: (sale: SaleDefinition) => Promise<void>;
  readonly drain: {
    /** Ignore queue readings for this long after pausing (see waitUntilDrained). */
    readonly settleMs: number;
    readonly timeoutMs: number;
    readonly pollMs: number;
  };
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}
