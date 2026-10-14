import { randomUUID } from 'node:crypto';

import { connect, type Channel, type ChannelModel } from 'amqplib';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DependencyUnavailableError } from '../../src/errors';
import { decodeOrderMessage, type OrderMessage } from '../../src/order';
import { RabbitMqOrderPublisher } from '../../src/order-publisher';

const RABBITMQ_URL = process.env.TEST_RABBITMQ_URL ?? 'amqp://flash:flash@localhost:5672';
const logger = pino({ level: 'silent' });

const order = (): OrderMessage => ({
  orderId: randomUUID(),
  saleId: 'test-sale',
  userId: `user-${randomUUID().slice(0, 8)}`,
  purchasedAt: Date.now(),
});

describe('RabbitMqOrderPublisher (real RabbitMQ)', () => {
  let connection: ChannelModel;
  let channel: Channel;
  let queue: string;
  let publisher: RabbitMqOrderPublisher;

  beforeAll(async () => {
    connection = await connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    queue = `test-orders-${randomUUID().slice(0, 8)}`;
    await channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });

    publisher = new RabbitMqOrderPublisher({
      url: RABBITMQ_URL,
      logger,
      confirmTimeoutMs: 2_000,
      queue,
    });
    await publisher.start();
  });

  afterAll(async () => {
    await publisher.close();
    await channel.deleteQueue(queue);
    await connection.close();
  });

  it('resolves only after the broker confirmed, and the message is in the queue', async () => {
    const message = order();

    await publisher.publish(message);

    const received = await channel.get(queue, { noAck: true });
    expect(received).not.toBe(false);
    if (received === false) return;
    expect(decodeOrderMessage(received.content)).toEqual(message);
    expect(received.properties).toMatchObject({
      messageId: message.orderId,
      contentType: 'application/json',
      deliveryMode: 2, // persistent
    });
  });

  it('confirms many concurrent publishes on one channel', async () => {
    const messages = Array.from({ length: 200 }, order);

    await Promise.all(messages.map((message) => publisher.publish(message)));

    const { messageCount } = await channel.checkQueue(queue);
    expect(messageCount).toBe(200);
    await channel.purgeQueue(queue);
  });

  it('fails instead of pretending success when the queue does not exist', async () => {
    const lost = new RabbitMqOrderPublisher({
      url: RABBITMQ_URL,
      logger,
      confirmTimeoutMs: 2_000,
      queue: `missing-${randomUUID()}`,
    });
    await lost.start();
    try {
      await expect(lost.publish(order())).rejects.toThrow(DependencyUnavailableError);
    } finally {
      await lost.close();
    }
  });

  it('fails fast while it is not connected', async () => {
    const neverStarted = new RabbitMqOrderPublisher({
      url: RABBITMQ_URL,
      logger,
      confirmTimeoutMs: 2_000,
    });

    await expect(neverStarted.publish(order())).rejects.toThrow(DependencyUnavailableError);
  });
});
