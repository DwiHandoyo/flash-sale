import { randomUUID } from 'node:crypto';

import { saleKeys } from '@flash-sale/shared/redis-keys';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisSaleStore } from '../../src/adapters/redis/redis-sale-store';
import { describeSaleStoreContract } from '../contracts/sale-store-contract';
import { activeSale, users } from '../helpers/sales';
import { TEST_REDIS_URL, writeSale } from './infra';

const CONNECTIONS = 20;

describe('RedisSaleStore (real Redis)', () => {
  let redis: Redis;
  let pool: Redis[];

  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL);
    // Separate connections, so requests really race each other like separate API servers would.
    pool = Array.from({ length: CONNECTIONS }, () => new Redis(TEST_REDIS_URL));
  });

  afterAll(async () => {
    await Promise.all([redis, ...pool].map((client) => client.quit()));
  });

  describeSaleStoreContract('RedisSaleStore', async ({ sale, paused }) => {
    if (!sale) return new RedisSaleStore(redis, `missing-${randomUUID()}`);
    await writeSale(redis, sale, { paused });
    return new RedisSaleStore(redis, sale.id);
  });

  it('never oversells when requests race over many connections', async () => {
    const sale = activeSale({ totalStock: 25 });
    await writeSale(redis, sale);
    const stores = pool.map((client) => new RedisSaleStore(client, sale.id));

    const results = await Promise.all(
      users(500).map((userId, i) => stores[i % CONNECTIONS]!.reserve(userId, randomUUID())),
    );

    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(25);
    expect(await redis.hget(saleKeys(sale.id).sale, 'remainingStock')).toBe('0');
    expect(await redis.hlen(saleKeys(sale.id).buyers)).toBe(25);
  });

  it('why atomicity matters: a naive "read, then decrement" oversells under the same race', async () => {
    const sale = activeSale({ totalStock: 10 });
    await writeSale(redis, sale);
    const { sale: saleKey } = saleKeys(sale.id);

    // Two separate commands: every request can read "stock left" before anyone decrements.
    const naivePurchase = async (client: Redis) => {
      const stock = Number(await client.hget(saleKey, 'remainingStock'));
      if (stock <= 0) return false;
      await client.hincrby(saleKey, 'remainingStock', -1);
      return true;
    };

    const sold = (
      await Promise.all(users(500).map((_, i) => naivePurchase(pool[i % CONNECTIONS]!)))
    ).filter(Boolean).length;

    expect(sold).toBeGreaterThan(10);
    expect(Number(await redis.hget(saleKey, 'remainingStock'))).toBeLessThan(0);
  });

  it('keeps working after Redis forgets the cached script (e.g. a restart)', async () => {
    const sale = activeSale({ totalStock: 3 });
    await writeSale(redis, sale);
    const store = new RedisSaleStore(redis, sale.id);

    await redis.script('FLUSH');

    await expect(store.reserve('alice', randomUUID())).resolves.toMatchObject({ kind: 'reserved' });
  });
});
