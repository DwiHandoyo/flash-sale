import { randomUUID } from 'node:crypto';

import { decodeOrderMessage } from '@flash-sale/shared/order';
import { RabbitMqOrderPublisher } from '@flash-sale/shared/order-publisher';
import { saleKeys } from '@flash-sale/shared/redis-keys';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/adapters/http/app';
import { RedisSaleStore } from '../../src/adapters/redis/redis-sale-store';
import { CachedValue } from '../../src/app/cached-value';
import { createUseCases } from '../../src/app/use-cases';
import { activeSale, users } from '../helpers/sales';
import { deleteSale, TEST_RABBITMQ_URL, TEST_REDIS_URL, writeSale } from './infra';

const logger = pino({ level: 'silent' });

/** The real API, wired like main.ts, against real Redis and RabbitMQ, on a random port. */
async function startApi(redis: Redis, saleId: string, queue: string) {
  const saleStore = new RedisSaleStore(redis, saleId);
  const publisher = new RabbitMqOrderPublisher({
    url: TEST_RABBITMQ_URL,
    logger,
    confirmTimeoutMs: 2_000,
    queue,
  });
  await publisher.start();
  const app = await buildApp({
    useCases: createUseCases({
      saleId,
      saleStore,
      publisher,
      saleState: new CachedValue(() => saleStore.getState(), 0),
      clock: Date.now,
      newOrderId: randomUUID,
    }),
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { url, close: () => app.close().then(() => publisher.close()) };
}

interface PurchaseBody {
  code: string;
  order?: { orderId: string };
}

const buy = (url: string, userId: string) =>
  fetch(`${url}/api/purchases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  }).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as PurchaseBody,
  }));

describe('API with real Redis and RabbitMQ', () => {
  let redis: Redis;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    redis = new Redis(TEST_REDIS_URL);
    connection = await connect(TEST_RABBITMQ_URL);
    channel = await connection.createChannel();
  });

  afterAll(async () => {
    await connection.close();
    await redis.quit();
  });

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

  it('sells exactly the stock to 300 concurrent buyers, and every 201 has its order in RabbitMQ', async () => {
    const sale = activeSale({ totalStock: 10 });
    const queue = `test-orders-${randomUUID().slice(0, 8)}`;
    await writeSale(redis, sale);
    await channel.assertQueue(queue, { arguments: { 'x-queue-type': 'quorum' } });
    const api = await startApi(redis, sale.id, queue);

    try {
      const responses = await Promise.all(users(300).map((userId) => buy(api.url, userId)));

      const purchased = responses.filter((response) => response.status === 201);
      expect(purchased).toHaveLength(10);
      expect(responses.filter((response) => response.body.code === 'sold_out')).toHaveLength(290);

      const messages = await drain(queue);
      expect(messages.map((message) => message.orderId).sort()).toEqual(
        purchased.map((response) => response.body.order?.orderId).sort(),
      );
      expect(await redis.hget(saleKeys(sale.id).sale, 'remainingStock')).toBe('0');
      expect(await redis.hlen(saleKeys(sale.id).buyers)).toBe(10);
    } finally {
      await api.close();
      await channel.deleteQueue(queue);
      await deleteSale(redis, sale.id);
    }
  });

  it('answers 503 when RabbitMQ cannot store the order, then completes it when the buyer retries', async () => {
    const sale = activeSale({ totalStock: 5 });
    // The queue does not exist yet, so RabbitMQ cannot store the order.
    const queue = `test-orders-${randomUUID().slice(0, 8)}`;
    await writeSale(redis, sale);
    const api = await startApi(redis, sale.id, queue);

    try {
      const first = await buy(api.url, 'alice');
      expect(first.status).toBe(503);
      expect(first.body.code).toBe('service_unavailable');
      // The unit stays reserved for alice.
      expect(await redis.hexists(saleKeys(sale.id).buyers, 'alice')).toBe(1);

      await channel.assertQueue(queue, { arguments: { 'x-queue-type': 'quorum' } });
      const retry = await buy(api.url, 'alice');

      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('already_purchased');
      const messages = await drain(queue);
      expect(messages.map((message) => message.orderId)).toEqual([retry.body.order?.orderId]);
    } finally {
      await api.close();
      await channel.deleteQueue(queue);
      await deleteSale(redis, sale.id);
    }
  });
});
