import type { SaleDefinition } from '@flash-sale/shared/sale';

import type { JobDependencies } from './ports';

/**
 * Restarts the sale from scratch with a new definition: full stock, no buyers, no orders. For
 * demos and stress tests only, while no traffic is flowing. It would sell units twice if real
 * sales had happened, which is why bootstrap never does this.
 */
export async function resetSale(deps: JobDependencies, sale: SaleDefinition): Promise<void> {
  const { queues, saleState, logger } = deps;

  await deps.migrate();
  await queues.declareTopology();
  // Old orders must not reach the database after it is cleaned.
  await queues.purge();
  await deps.resetPersistedSale(sale);
  // Redis last: the sale only becomes active once everything behind it is clean.
  await saleState.reset(sale);

  logger.info(
    {
      saleId: sale.id,
      totalStock: sale.totalStock,
      startsAt: new Date(sale.startsAt).toISOString(),
      endsAt: new Date(sale.endsAt).toISOString(),
    },
    'Sale reset',
  );
}
