import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { decodeOrderMessage, type Order } from '@flash-sale/shared/order';
import { RabbitMqOrderPublisher } from '@flash-sale/shared/order-publisher';
import {
  createPgPool,
  migrate,
  OrderRepository,
  SaleRepository,
  withTransaction,
} from '@flash-sale/shared/postgres';
import { encodeBuyerRecord, SALE_FIELDS, saleKeys } from '@flash-sale/shared/redis-keys';
import type { SaleDefinition } from '@flash-sale/shared/sale';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RabbitMqQueueAdmin } from '../../src/adapters/rabbitmq/rabbitmq-queue-admin';
import { RedisSaleStateStore } from '../../src/adapters/redis/redis-sale-state-store';
import { bootstrap } from '../../src/app/bootstrap';
import type { JobDependencies } from '../../src/app/ports';
import { reconcile } from '../../src/app/reconcile';
import { recover, RecoveryBlockedError } from '../../src/app/recover';
import { resetSale } from '../../src/app/reset-sale';
import {
  TEST_DATABASE_URL,
  TEST_RABBITMQ_MANAGEMENT_URL,
  TEST_RABBITMQ_URL,
  TEST_REDIS_URL,
  uniqueQueues,
  waitUntil,
} from './infra';

const logger = pino({ level: 'silent' });

describe('jobs with real Redis, PostgreSQL and RabbitMQ', () => {
  let redis: Redis;
  let pool: pg.Pool;
  let connection: ChannelModel;
  let channel: Channel;
  const cleanups: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    redis = new Redis(TEST_REDIS_URL);
    pool = createPgPool(TEST_DATABASE_URL);
    connection = await connect(TEST_RABBITMQ_URL);
    channel = await connection.createChannel();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(async () => {
    await connection.close();
    await pool.end();
    await redis.quit();
  });

  /** A fresh sale on its own queues, with the jobs wired as in main.ts. */
  async function setup(totalStock = 10) {
    const now = Date.now();
    const sale: SaleDefinition = {
      id: `test-${randomUUID().slice(0, 8)}`,
      totalStock,
      startsAt: now - 60_000,
      endsAt: now + 60_000,
    };
    const queues = uniqueQueues();
    const publisher = new RabbitMqOrderPublisher({
      url: TEST_RABBITMQ_URL,
      logger,
      confirmTimeoutMs: 2_000,
      queue: queues.orders,
    });
    await publisher.start();

    const deps: JobDependencies = {
      saleId: sale.id,
      logger,
      sales: new SaleRepository(pool),
      orders: new OrderRepository(pool),
      saleState: new RedisSaleStateStore(redis, sale.id),
      queues: new RabbitMqQueueAdmin({
        amqpUrl: TEST_RABBITMQ_URL,
        managementUrl: TEST_RABBITMQ_MANAGEMENT_URL,
        queues,
      }),
      publisher,
      migrate: () => migrate(pool),
      resetPersistedSale: (definition) =>
        withTransaction(pool, async (client) => {
          await new SaleRepository(client).reset(definition);
          await new OrderRepository(client).deleteBySale(definition.id);
        }),
      // Longer than the age of RabbitMQ's sampled counts locally (see docker-compose.yml).
      drain: { settleMs: 3_000, timeoutMs: 30_000, pollMs: 200 },
      clock: Date.now,
      sleep: (ms) => sleep(ms),
    };

    cleanups.push(async () => {
      await publisher.close();
      await channel.deleteQueue(queues.orders);
      await channel.deleteQueue(queues.deadLetter);
      await pool.query('DELETE FROM sales WHERE id = $1', [sale.id]);
      const keys = saleKeys(sale.id);
      await redis.del(keys.sale, keys.buyers);
    });
    return { sale, queues, deps, publisher };
  }

  const keysOf = (sale: SaleDefinition) => saleKeys(sale.id);
  const order = (userId: string): Order => ({
    orderId: randomUUID(),
    userId,
    purchasedAt: Date.now(),
  });

  /** What the API's reserve script does for a winner. */
  async function reserveInRedis(sale: SaleDefinition, orders: Order[]) {
    for (const reserved of orders) {
      await redis.hset(keysOf(sale).buyers, reserved.userId, encodeBuyerRecord(reserved));
      await redis.hincrby(keysOf(sale).sale, SALE_FIELDS.remainingStock, -1);
    }
  }

  async function redisSnapshot(sale: SaleDefinition) {
    const [remainingStock, paused] = await redis.hmget(
      keysOf(sale).sale,
      SALE_FIELDS.remainingStock,
      SALE_FIELDS.paused,
    );
    const buyers = Object.keys(await redis.hgetall(keysOf(sale).buyers)).sort();
    return { remainingStock: Number(remainingStock), paused: paused != null, buyers };
  }

  async function drain(queue: string) {
    const messages = [];
    for (
      let message = await channel.get(queue, { noAck: true });
      message;
      message = await channel.get(queue, { noAck: true })
    ) {
      messages.push(decodeOrderMessage(message.content));
    }
    return messages;
  }

  it('bootstrap on first boot creates the sale, the queues and a full stock in Redis', async () => {
    const { sale, queues, deps } = await setup(10);

    await bootstrap(deps, sale);

    expect(await deps.sales.find(sale.id)).toMatchObject({ totalStock: 10, soldCount: 0 });
    expect(await redisSnapshot(sale)).toEqual({ remainingStock: 10, paused: false, buyers: [] });
    expect((await channel.checkQueue(queues.orders)).messageCount).toBe(0);
  });

  it('bootstrap on a restart keeps every reservation and re-publishes those without an order', async () => {
    const { sale, queues, deps } = await setup(10);
    await bootstrap(deps, sale);
    const [saved, unconfirmed] = [order('alice'), order('bob')];
    await reserveInRedis(sale, [saved, unconfirmed]);
    await deps.orders.saveOrders(sale.id, [saved]);

    await bootstrap(deps, sale);

    expect(await redisSnapshot(sale)).toEqual({
      remainingStock: 8,
      paused: false,
      buyers: ['alice', 'bob'],
    });
    expect((await drain(queues.orders)).map((message) => message.orderId)).toEqual([
      unconfirmed.orderId,
    ]);
  });

  it('bootstrap after Redis lost its data rebuilds it from PostgreSQL', async () => {
    const { sale, deps } = await setup(10);
    await bootstrap(deps, sale);
    await deps.orders.saveOrders(sale.id, [order('alice'), order('bob'), order('carol')]);
    await redis.del(keysOf(sale).sale, keysOf(sale).buyers); // Redis comes back empty

    await bootstrap(deps, sale);

    expect(await redisSnapshot(sale)).toEqual({
      remainingStock: 7,
      paused: false,
      buyers: ['alice', 'bob', 'carol'],
    });
  });

  it('recover pauses the sale and waits for the orders still in flight', async () => {
    const { sale, queues, deps, publisher } = await setup(10);
    await bootstrap(deps, sale);
    const alice = order('alice');
    await deps.orders.saveOrders(sale.id, [alice]);
    // A failover replica that knows a buyer whose publish was never confirmed.
    await reserveInRedis(sale, [alice, order('stale-buyer')]);
    // Two confirmed orders still waiting in RabbitMQ (no worker is running).
    const inFlight = [order('bob'), order('carol')];
    for (const pending of inFlight) await publisher.publish({ ...pending, saleId: sale.id });

    const recovery = recover(deps);
    await waitUntil(async () => (await redisSnapshot(sale)).paused);
    // The recovery must not finish while orders are in flight.
    await sleep(3_500);
    expect((await redisSnapshot(sale)).paused).toBe(true);

    // A worker saves them.
    const messages = await drain(queues.orders);
    await deps.orders.saveOrders(sale.id, messages);
    await recovery;

    expect(await redisSnapshot(sale)).toEqual({
      remainingStock: 7,
      paused: false,
      buyers: ['alice', 'bob', 'carol'],
    });
  });

  it('recover also waits for orders a worker holds without having acknowledged them', async () => {
    const { sale, queues, deps, publisher } = await setup(10);
    await bootstrap(deps, sale);
    const held = [order('dave'), order('erin')];
    for (const pending of held) await publisher.publish({ ...pending, saleId: sale.id });

    // A slow worker takes both messages and holds them: they are no longer "waiting" in the
    // queue (AMQP reports 0), only the management API still counts them.
    const workerConnection = await connect(TEST_RABBITMQ_URL);
    const workerChannel = await workerConnection.createChannel();
    const deliveries: { content: Buffer; ack: () => void }[] = [];
    await workerChannel.consume(queues.orders, (message) => {
      if (message)
        deliveries.push({ content: message.content, ack: () => workerChannel.ack(message) });
    });
    await waitUntil(async () => deliveries.length === 2);

    const recovery = recover(deps);
    await sleep(5_000);
    expect((await redisSnapshot(sale)).paused).toBe(true);

    // The worker finally saves and acknowledges them.
    await deps.orders.saveOrders(
      sale.id,
      deliveries.map((delivery) => decodeOrderMessage(delivery.content)),
    );
    for (const delivery of deliveries) delivery.ack();
    await recovery;
    await workerConnection.close();

    expect(await redisSnapshot(sale)).toEqual({
      remainingStock: 8,
      paused: false,
      buyers: ['dave', 'erin'],
    });
  });

  it('reconcile publishes nothing while the sale is paused for recovery', async () => {
    const { sale, queues, deps } = await setup(10);
    await bootstrap(deps, sale);
    await reserveInRedis(sale, [order('alice')]);
    await deps.saleState.pause(sale);

    await expect(reconcile(deps)).resolves.toMatchObject({ skipped: 'paused', republished: 0 });
    expect((await channel.checkQueue(queues.orders)).messageCount).toBe(0);
  });

  it('recover refuses to rebuild while orders sit in the dead-letter queue', async () => {
    const { sale, queues, deps } = await setup(10);
    await bootstrap(deps, sale);
    channel.sendToQueue(queues.deadLetter, Buffer.from('{}'));

    await expect(recover(deps)).rejects.toThrow(RecoveryBlockedError);
    expect((await redisSnapshot(sale)).paused).toBe(true);
  });

  it('reset restarts the sale: full stock, no buyers, no orders, no queued messages', async () => {
    const { sale, queues, deps, publisher } = await setup(10);
    await bootstrap(deps, sale);
    const alice = order('alice');
    await reserveInRedis(sale, [alice]);
    await deps.orders.saveOrders(sale.id, [alice]);
    await publisher.publish({ ...order('bob'), saleId: sale.id });

    await resetSale(deps, { ...sale, totalStock: 3 });

    expect(await redisSnapshot(sale)).toEqual({ remainingStock: 3, paused: false, buyers: [] });
    expect(await deps.sales.find(sale.id)).toMatchObject({ totalStock: 3, soldCount: 0 });
    expect(await deps.orders.countBySale(sale.id)).toBe(0);
    expect((await channel.checkQueue(queues.orders)).messageCount).toBe(0);
  });
});
