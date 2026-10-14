import type { JobDependencies } from './ports';
import { reconcile } from './reconcile';

export interface ScheduleOptions {
  readonly intervalMs: number;
  readonly retryDelayMs: number;
  readonly signal: AbortSignal;
}

/**
 * The runs that are due and not done yet: reconciliation at `endsAt`, and once more `retryDelayMs`
 * later in case the first run failed. Keys include `endsAt`, so a reset sale gets fresh runs.
 */
export function dueReconcileRuns(
  sale: { readonly id: string; readonly endsAt: number },
  now: number,
  done: ReadonlySet<string>,
  retryDelayMs: number,
): string[] {
  return [sale.endsAt, sale.endsAt + retryDelayMs]
    .filter((at) => now >= at)
    .map((at) => `${sale.id}@${at}`)
    .filter((key) => !done.has(key));
}

/**
 * The local stand-in for EventBridge Scheduler (docs/10, "Scheduling"): checks every
 * `intervalMs` whether a reconciliation run is due. The sale is read from PostgreSQL each time, so
 * a reset with new times is picked up. Reconciliation is idempotent, so running it again after a
 * restart is harmless.
 */
export async function runScheduler(deps: JobDependencies, options: ScheduleOptions): Promise<void> {
  const { saleId, sales, logger, clock } = deps;
  const done = new Set<string>();
  logger.info({ saleId }, 'Scheduler started');

  while (!options.signal.aborted) {
    try {
      const sale = await sales.find(saleId);
      for (const run of sale ? dueReconcileRuns(sale, clock(), done, options.retryDelayMs) : []) {
        logger.info({ run }, 'Running scheduled reconciliation');
        await reconcile(deps);
        done.add(run);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Scheduled check failed; will try again');
    }
    await deps.sleep(options.intervalMs);
  }
}
