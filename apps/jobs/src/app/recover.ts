import type { JobDependencies } from './ports';

export class RecoveryBlockedError extends Error {
  override name = 'RecoveryBlockedError';
}

/**
 * Rebuilds Redis from PostgreSQL after Redis lost data (docs/06, "Recovery procedure"):
 * pause → drain → check dead letters → rebuild → resume.
 *
 * Every order a user was told about was confirmed by RabbitMQ, so once the queue has drained into
 * PostgreSQL, PostgreSQL holds all of them. Reservations that were never confirmed were never
 * promised to anyone and are released. While this runs, the sale stays paused: correctness wins
 * over availability.
 */
export async function recover(
  deps: JobDependencies,
): Promise<{ orders: number; remainingStock: number }> {
  const { saleId, sales, orders, saleState, queues, logger, clock } = deps;

  const sale = await sales.find(saleId);
  if (!sale) throw new RecoveryBlockedError(`Sale "${saleId}" does not exist in PostgreSQL`);

  // 1. Pause. Explicitly, because after a failover Redis still has data, just stale data.
  await saleState.pause(sale);
  const pausedAt = clock();
  logger.warn({ saleId }, 'Sale paused for recovery');

  // 2. Drain: the workers keep saving orders; nothing new arrives while the sale is paused.
  await waitUntilDrained(
    deps,
    pausedAt,
    async () => (await orders.countBySale(saleId)) >= sale.totalStock,
  );

  // 3. Orders in the dead-letter queue are not in PostgreSQL. Rebuilding without them would count
  //    too few sold units and could oversell, so stop here and leave the sale paused.
  const deadLetters = await queues.deadLetters();
  if (deadLetters > 0) {
    throw new RecoveryBlockedError(
      `${deadLetters} order(s) in the dead-letter queue must be resolved first; the sale stays paused`,
    );
  }

  // 4. Rebuild buyers and stock from PostgreSQL, then 5. resume.
  const persisted = await orders.listBySale(saleId);
  await saleState.rebuild(sale, persisted);
  await saleState.resume();
  // Released reservations can turn "sold out" back into "active"; do not let the CDN hide that.
  await deps.statusCache.refresh();

  const remainingStock = Math.max(0, sale.totalStock - persisted.length);
  logger.info({ saleId, orders: persisted.length, remainingStock }, 'Sale recovered and resumed');
  return { orders: persisted.length, remainingStock };
}

/**
 * Waits until no order is in flight: none waiting in the queue and none held by a worker.
 *
 * Once the sale is paused, no new order can be published. The only exceptions are purchases
 * decided just before the pause, whose publish is bounded by its confirm timeout. From then on,
 * the number of orders in flight can only go down: acks and dead-lettering remove messages, and a
 * requeue moves one without adding any. The counts RabbitMQ reports are sampled and can describe
 * the queue as it was a few seconds earlier. So readings are ignored for `settleMs` after the
 * pause, longer than that delay plus the publish timeout. After that, the first reading of zero
 * means the queue is drained.
 *
 * Stops early when `sold` reports that every unit is already persisted.
 */
export async function waitUntilDrained(
  deps: Pick<JobDependencies, 'queues' | 'drain' | 'clock' | 'sleep' | 'logger'>,
  pausedAt: number,
  sold: () => Promise<boolean>,
): Promise<void> {
  const { queues, drain, clock, sleep, logger } = deps;
  const settledAt = pausedAt + drain.settleMs;
  const deadline = pausedAt + drain.timeoutMs;

  for (;;) {
    if (await sold()) return;

    const now = clock();
    if (now >= settledAt) {
      const inFlight = await queues.ordersInFlight();
      if (inFlight === 0) return;
      logger.info(
        { inFlight: inFlight ?? 'unknown' },
        'Waiting for the workers to save the remaining orders',
      );
    }

    if (now >= deadline) {
      throw new RecoveryBlockedError(
        `The order queue did not drain within ${drain.timeoutMs} ms. Are the workers running?`,
      );
    }
    await sleep(drain.pollMs);
  }
}
