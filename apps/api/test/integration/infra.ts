import { SALE_FIELDS, saleKeys } from '@flash-sale/shared/redis-keys';
import type { SaleDefinition } from '@flash-sale/shared/sale';
import type { Redis } from 'ioredis';

/** Database 1, so tests never touch the demo data in database 0. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:16379/1';
export const TEST_RABBITMQ_URL =
  process.env.TEST_RABBITMQ_URL ?? 'amqp://flash:flash@localhost:5672';

/** Writes a fresh sale into Redis, the way the bootstrap job will. */
export async function writeSale(
  redis: Redis,
  sale: SaleDefinition,
  { paused = false } = {},
): Promise<void> {
  const keys = saleKeys(sale.id);
  const transaction = redis
    .multi()
    .del(keys.sale, keys.buyers)
    .hset(keys.sale, {
      [SALE_FIELDS.startsAt]: sale.startsAt,
      [SALE_FIELDS.endsAt]: sale.endsAt,
      [SALE_FIELDS.totalStock]: sale.totalStock,
      [SALE_FIELDS.remainingStock]: sale.totalStock,
    });
  if (paused) transaction.hset(keys.sale, SALE_FIELDS.paused, '1');
  await transaction.exec();
}

export async function deleteSale(redis: Redis, saleId: string): Promise<void> {
  const keys = saleKeys(saleId);
  await redis.del(keys.sale, keys.buyers);
}
