import type { SaleDefinition } from '@flash-sale/shared/sale';

import type { JobDependencies } from './ports';
import { reconcile } from './reconcile';
import { recover } from './recover';

/**
 * Prepares everything before the API serves traffic (docs/04, "Lifecycle"). Safe to run any number
 * of times: at every start-up, and in production 10 minutes before each sale.
 */
export async function bootstrap(deps: JobDependencies, definition: SaleDefinition): Promise<void> {
  const { sales, orders, saleState, queues, logger } = deps;

  await deps.migrate();
  const { sale, created } = await sales.ensure(definition);
  if (!created) logger.info('The sale already exists; keeping its stored definition');
  await queues.declareTopology();

  const state = await saleState.getState();
  const persisted = await orders.listBySale(sale.id);

  if ((!state && persisted.length > 0) || state?.paused) {
    // Redis came back empty although orders exist (it lost its data), or an earlier recovery
    // did not finish. Either way, only the full recovery procedure is safe.
    logger.warn({ saleId: sale.id }, 'Redis is not in a usable state; running recovery');
    await recover(deps);
  } else {
    const report = await saleState.sync(sale, persisted);
    logger.info({ saleId: sale.id, ...report }, 'Redis is in sync with PostgreSQL');
  }

  await reconcile(deps);
  logger.info(
    {
      saleId: sale.id,
      totalStock: sale.totalStock,
      startsAt: new Date(sale.startsAt).toISOString(),
      endsAt: new Date(sale.endsAt).toISOString(),
    },
    'Sale is ready',
  );
}
