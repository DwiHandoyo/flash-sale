import {
  declareOrderTopology,
  DEFAULT_ORDER_QUEUES,
  type OrderQueues,
} from '@flash-sale/shared/rabbitmq';
import { connect, type Channel } from 'amqplib';

import type { QueueAdmin } from '../../app/ports';

export interface QueueAdminOptions {
  readonly amqpUrl: string;
  /** For example http://user:password@localhost:15672 */
  readonly managementUrl: string;
  readonly queues?: OrderQueues;
}

/**
 * Declares, purges and measures the order queues.
 *
 * Counting: AMQP reports messages waiting in a queue exactly and in real time, but not messages a
 * worker holds without having acknowledged them yet. Only the management API reports those, and
 * its numbers are sampled, a few seconds old. ordersInFlight combines both; waitUntilDrained
 * explains why that is safe once the sale is paused.
 */
export class RabbitMqQueueAdmin implements QueueAdmin {
  private readonly queues: OrderQueues;
  private readonly apiBase: string;
  private readonly authorization: string;

  constructor(private readonly options: QueueAdminOptions) {
    this.queues = options.queues ?? DEFAULT_ORDER_QUEUES;
    const url = new URL(options.managementUrl);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    this.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    url.username = '';
    url.password = '';
    this.apiBase = url.toString().replace(/\/$/, '');
  }

  async declareTopology(): Promise<void> {
    await this.withChannel((channel) => declareOrderTopology(channel, this.queues));
  }

  async ordersInFlight(): Promise<number | undefined> {
    const [waiting, sampledTotal] = await Promise.all([
      this.waitingMessages(this.queues.orders),
      this.sampledMessageCount(this.queues.orders),
    ]);
    return sampledTotal === undefined ? undefined : Math.max(waiting, sampledTotal);
  }

  /** Nothing consumes the dead-letter queue, so every message in it is waiting: AMQP is exact. */
  async deadLetters(): Promise<number> {
    return this.waitingMessages(this.queues.deadLetter);
  }

  async purge(): Promise<void> {
    await this.withChannel(async (channel) => {
      await channel.purgeQueue(this.queues.orders);
      await channel.purgeQueue(this.queues.deadLetter);
    });
  }

  /** Messages waiting for a consumer, exact and real time (AMQP passive declare). */
  private async waitingMessages(queue: string): Promise<number> {
    return this.withChannel(async (channel) => (await channel.checkQueue(queue)).messageCount);
  }

  /**
   * Waiting plus unacknowledged messages, from the management API's sampled statistics, or
   * undefined while it has no statistics for the queue yet.
   */
  private async sampledMessageCount(queue: string): Promise<number | undefined> {
    const response = await fetch(`${this.apiBase}/api/queues/%2F/${encodeURIComponent(queue)}`, {
      headers: { authorization: this.authorization },
    });
    if (!response.ok) throw new Error(`RabbitMQ management API answered ${response.status}`);
    const { messages } = (await response.json()) as { messages?: number };
    return messages;
  }

  private async withChannel<T>(work: (channel: Channel) => Promise<T>): Promise<T> {
    const connection = await connect(this.options.amqpUrl);
    try {
      return await work(await connection.createChannel());
    } finally {
      await connection.close();
    }
  }
}
