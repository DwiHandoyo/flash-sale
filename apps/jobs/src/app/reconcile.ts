import type { JobDependencies } from './ports';

export interface ReconcileReport {
  readonly buyers: number;
  readonly persisted: number;
  readonly republished: number;
  readonly skipped?: 'paused';
}

/**
 * Completes reservations whose publish was never confirmed: every buyer in Redis without an order
 * record in PostgreSQL is published again (docs/06, "Reconciliation"). An order that is still on
 * its way in RabbitMQ is published twice, which is harmless because the worker skips duplicates.
 */
export async function reconcile(deps: JobDependencies): Promise<ReconcileReport> {
  const { saleId, saleState, orders, publisher, logger } = deps;

  // During recovery, Redis may hold stale buyers, and publishing would refill the queue the
  // recovery is waiting to drain. The recovery rebuilds Redis from PostgreSQL anyway.
  if ((await saleState.getState())?.paused) {
    logger.warn({ saleId }, 'Sale is paused for recovery; skipping reconciliation');
    return { buyers: 0, persisted: 0, republished: 0, skipped: 'paused' };
  }

  const buyers = await saleState.listBuyers();
  const persistedUsers = new Set((await orders.listBySale(saleId)).map((order) => order.userId));
  const missing = buyers.filter((buyer) => !persistedUsers.has(buyer.userId));

  for (const order of missing) await publisher.publish({ ...order, saleId });

  const report = {
    buyers: buyers.length,
    persisted: persistedUsers.size,
    republished: missing.length,
  };
  logger.info(report, 'Reconciled Redis buyers with PostgreSQL orders');
  return report;
}
