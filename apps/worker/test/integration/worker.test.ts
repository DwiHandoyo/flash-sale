import { randomUUID } from 'node:crypto';

import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import type { OrderMessage } from '@flash-sale/shared/order';
import { RabbitMqOrderPublisher } from '@flash-sale/shared/order-publisher';
import { createPgPool, OrderRepository, SaleRepository } from '@flash-sale/shared/postgres';
import type { OrderQueues } from '@flash-sale/shared/rabbitmq';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import type pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RabbitMqOrderConsumer } from '../../src/adapters/rabbitmq/order-consumer';
import { createSaveOrders } from '../../src/app/save-orders';
import {
  orderMessage,
  TEST_DATABASE_URL,
  TEST_RABBITMQ_URL,
  uniqueQueues,
  waitUntil,
} from './infra';

const logger = pino({ level: 'silent' });

describe('worker with real RabbitMQ and PostgreSQL', () => {
  let pool: pg.Pool;
  let orders: OrderRepository;
  let sales: SaleRepository;
  let connection: ChannelModel;
  let channel: Channel;
  const cleanups: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    pool = createPgPool(TEST_DATABASE_URL);
    orders = new OrderRepository(pool);
    sales = new SaleRepository(pool);
    connection = await connect(TEST_RABBITMQ_URL);
    channel = await connection.createChannel();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(async () => {
    await connection.close();
    await pool.end();
  });

  async function createSale(totalStock = 100) {
    const saleId = `test-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await sales.ensure({ id: saleId, totalStock, startsAt: now - 60_000, endsAt: now + 60_000 });
    cleanups.push(() => pool.query('DELETE FROM sales WHERE id = $1', [saleId]));
    return saleId;
  }

  /** Starts a worker on its own queues. `handle` can wrap the real save to inject failures. */
  async function startWorker(
    queues: OrderQueues,
    wrap: (
      save: (messages: OrderMessage[]) => Promise<void>,
    ) => (messages: OrderMessage[]) => Promise<void> = (save) => save,
  ) {
    const saveOrders = createSaveOrders(orders);
    const consumer = new RabbitMqOrderConsumer({
      url: TEST_RABBITMQ_URL,
      logger,
      prefetch: 50,
      batchWindowMs: 20,
      maxRetryDelayMs: 200,
      queues,
      handle: wrap(async (messages) => {
        await saveOrders(messages);
      }),
    });
    await consumer.start();
    cleanups.push(async () => {
      await consumer.stop();
      await channel.deleteQueue(queues.orders);
      await channel.deleteQueue(queues.deadLetter);
    });
    return consumer;
  }

  async function publish(queues: OrderQueues, messages: OrderMessage[]) {
    const publisher = new RabbitMqOrderPublisher({
      url: TEST_RABBITMQ_URL,
      logger,
      confirmTimeoutMs: 2_000,
      queue: queues.orders,
    });
    await publisher.start();
    try {
      for (const message of messages) await publisher.publish(message);
    } finally {
      await publisher.close();
    }
  }

  const soldCount = async (saleId: string) => (await sales.find(saleId))?.soldCount;
  const queueDepth = async (queue: string) => (await channel.checkQueue(queue)).messageCount;

  it('saves published orders, counts them as sold and acknowledges them', async () => {
    const saleId = await createSale();
    const queues = uniqueQueues();
    const consumer = await startWorker(queues);
    const messages = Array.from({ length: 50 }, () => orderMessage(saleId));

    await publish(queues, messages);
    await waitUntil(async () => (await orders.countBySale(saleId)) === 50);

    expect(await soldCount(saleId)).toBe(50);
    const saved = await orders.listBySale(saleId);
    expect(saved.map((order) => order.orderId).sort()).toEqual(
      messages.map((m) => m.orderId).sort(),
    );
    // Stopping hands back anything unacknowledged; nothing should come back.
    await consumer.stop();
    expect(await queueDepth(queues.orders)).toBe(0);
  });

  it('skips duplicates: a redelivered or re-published order is saved once', async () => {
    const saleId = await createSale();
    const queues = uniqueQueues();
    await startWorker(queues);
    const message = orderMessage(saleId);

    await publish(queues, [message, message, message]);
    await waitUntil(async () => (await queueDepth(queues.orders)) === 0);
    await waitUntil(async () => (await orders.countBySale(saleId)) === 1);

    expect(await soldCount(saleId)).toBe(1);
  });

  it('dead-letters an unreadable message and saves the others', async () => {
    const saleId = await createSale();
    const queues = uniqueQueues();
    await startWorker(queues);

    channel.sendToQueue(queues.orders, Buffer.from('{"not":"an order"}'));
    await publish(queues, [orderMessage(saleId), orderMessage(saleId)]);

    await waitUntil(async () => (await queueDepth(queues.deadLetter)) === 1);
    await waitUntil(async () => (await orders.countBySale(saleId)) === 2);
  });

  it('refuses an order that would oversell, without blocking the others', async () => {
    const saleId = await createSale(2);
    const queues = uniqueQueues();
    await startWorker(queues);

    await publish(queues, [orderMessage(saleId), orderMessage(saleId), orderMessage(saleId)]);

    await waitUntil(async () => (await queueDepth(queues.deadLetter)) === 1);
    expect(await orders.countBySale(saleId)).toBe(2);
    expect(await soldCount(saleId)).toBe(2);
  });

  it('retries in place while PostgreSQL is unavailable, without dead-lettering good orders', async () => {
    const saleId = await createSale();
    const queues = uniqueQueues();
    let failures = 0;
    await startWorker(queues, (save) => async (messages) => {
      if (failures < 5) {
        failures += 1;
        throw new DependencyUnavailableError('postgres', new Error('connection refused'));
      }
      await save(messages);
    });

    await publish(queues, [orderMessage(saleId), orderMessage(saleId)]);

    await waitUntil(async () => (await orders.countBySale(saleId)) === 2);
    expect(failures).toBe(5);
    expect(await queueDepth(queues.deadLetter)).toBe(0);
  });

  it('saves the orders a crashed worker received but never acknowledged', async () => {
    const saleId = await createSale();
    const queues = uniqueQueues();
    const messages = Array.from({ length: 5 }, () => orderMessage(saleId));

    // A worker that takes the messages and then dies before acknowledging them.
    const doomed = await connect(TEST_RABBITMQ_URL);
    const doomedChannel = await doomed.createChannel();
    await doomedChannel.assertQueue(queues.deadLetter, { arguments: { 'x-queue-type': 'quorum' } });
    await doomedChannel.assertQueue(queues.orders, {
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 10,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queues.deadLetter,
      },
    });
    let received = 0;
    await doomedChannel.consume(queues.orders, () => (received += 1));
    await publish(queues, messages);
    await waitUntil(async () => received === 5);
    await doomed.close();

    await startWorker(queues);

    await waitUntil(async () => (await orders.countBySale(saleId)) === 5);
    expect(await queueDepth(queues.deadLetter)).toBe(0);
  });
});
