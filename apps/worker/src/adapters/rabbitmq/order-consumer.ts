import { setTimeout as sleep } from 'node:timers/promises';

import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import type { Logger } from '@flash-sale/shared/logger';
import { decodeOrderMessage, type OrderMessage } from '@flash-sale/shared/order';
import {
  declareOrderTopology,
  DEFAULT_ORDER_QUEUES,
  type OrderQueues,
} from '@flash-sale/shared/rabbitmq';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  type RecoveringChannelModel,
} from 'amqplib';

export interface OrderConsumerOptions {
  readonly url: string;
  readonly logger: Logger;
  /** Saves a batch. Throws DependencyUnavailableError for temporary problems. */
  readonly handle: (messages: OrderMessage[]) => Promise<void>;
  /** Unacknowledged messages RabbitMQ may hand this worker at once, and the largest batch. */
  readonly prefetch: number;
  /** How long to wait for a batch to fill up before saving what has arrived. */
  readonly batchWindowMs: number;
  readonly maxRetryDelayMs: number;
  readonly queues?: OrderQueues;
  readonly startupRetries?: number;
}

interface Delivery {
  readonly channel: Channel;
  readonly message: ConsumeMessage;
}

type Settlement = 'ack' | 'requeue' | 'dead-letter';

/**
 * Consumes orders in batches and acknowledges each one only after it is saved.
 *
 * - **Temporary failure** (PostgreSQL down): the batch is retried here, with growing delays,
 *   while RabbitMQ keeps it as unacknowledged. Sending it back instead would use up the
 *   delivery limit within seconds and dead-letter good orders just because the database is down.
 * - **Rejected data** (unreadable message, or a constraint such as the oversell guard): the batch
 *   is split to find the culprit, which is dead-lettered for inspection. The rest are saved.
 * - **Crash**: RabbitMQ redelivers unacknowledged messages to another worker at once. The
 *   duplicates are skipped when saved.
 */
export class RabbitMqOrderConsumer {
  private connection: RecoveringChannelModel | undefined;
  private consumer: { channel: Channel; tag: string } | undefined;
  private pending: Delivery[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private processing: Promise<void> = Promise.resolve();
  private readonly stopController = new AbortController();
  private readonly queues: OrderQueues;

  constructor(private readonly options: OrderConsumerOptions) {
    this.queues = options.queues ?? DEFAULT_ORDER_QUEUES;
  }

  async start(): Promise<void> {
    const { logger, startupRetries = 15 } = this.options;
    this.connection = await connect(this.options.url, {
      recovery: {
        initialDelay: 200,
        maxDelay: 2_000,
        initialMaxRetries: startupRetries,
        maxRetries: Infinity,
        // Runs after every (re)connect: a fresh channel and subscription each time.
        setup: (model: ChannelModel) => this.subscribe(model),
      },
    });
    this.connection.on('connect', () =>
      logger.info({ queue: this.queues.orders }, 'Consuming orders'),
    );
    this.connection.on('disconnect', (error: Error) =>
      logger.warn({ err: error }, 'Disconnected from RabbitMQ, reconnecting'),
    );
    this.connection.on('error', (error: Error) => logger.warn({ err: error }, 'RabbitMQ error'));
  }

  /** Stops taking new messages, finishes the current batch, then disconnects. */
  async stop(): Promise<void> {
    this.stopController.abort();
    if (this.consumer) {
      await this.consumer.channel.cancel(this.consumer.tag).catch(() => undefined);
    }
    this.flush();
    await this.processing;
    await this.connection?.close();
  }

  private async subscribe(model: ChannelModel): Promise<void> {
    const channel = await model.createChannel();
    channel.on('error', (error: Error) =>
      this.options.logger.warn({ err: error }, 'RabbitMQ channel error'),
    );
    await declareOrderTopology(channel, this.queues);
    await channel.prefetch(this.options.prefetch);
    const { consumerTag } = await channel.consume(this.queues.orders, (message) => {
      if (message) this.receive({ channel, message });
    });
    this.consumer = { channel, tag: consumerTag };
  }

  private receive(delivery: Delivery): void {
    this.pending.push(delivery);
    if (this.pending.length >= this.options.prefetch) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), this.options.batchWindowMs);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;

    // One batch at a time keeps the database load and the acknowledgements simple.
    this.processing = this.processing
      .then(() => this.process(batch))
      .catch((error: unknown) => this.options.logger.error({ err: error }, 'Batch failed'));
  }

  private async process(batch: Delivery[]): Promise<void> {
    const readable: { delivery: Delivery; order: OrderMessage }[] = [];
    for (const delivery of batch) {
      try {
        readable.push({ delivery, order: decodeOrderMessage(delivery.message.content) });
      } catch (error) {
        this.options.logger.error(
          { err: error, messageId: delivery.message.properties.messageId as unknown },
          'Unreadable order message, dead-lettering it',
        );
        this.settle(delivery, 'dead-letter');
      }
    }
    await this.save(readable);
  }

  private async save(items: { delivery: Delivery; order: OrderMessage }[]): Promise<void> {
    if (items.length === 0) return;
    const { handle, logger, maxRetryDelayMs } = this.options;

    for (let attempt = 1; ; attempt += 1) {
      try {
        await handle(items.map((item) => item.order));
        for (const item of items) this.settle(item.delivery, 'ack');
        return;
      } catch (error) {
        if (!(error instanceof DependencyUnavailableError)) {
          // The data was refused. Split the batch to find the culprit and keep the rest.
          if (items.length > 1) {
            for (const item of items) await this.save([item]);
            return;
          }
          logger.error(
            { err: error, orderId: items[0]!.order.orderId },
            'Order rejected, dead-lettering it',
          );
          this.settle(items[0]!.delivery, 'dead-letter');
          return;
        }

        if (this.stopController.signal.aborted) {
          // Shutting down: hand the batch back so another worker can save it.
          for (const item of items) this.settle(item.delivery, 'requeue');
          return;
        }
        const delayMs = Math.min(200 * 2 ** (attempt - 1), maxRetryDelayMs);
        logger.warn(
          { err: error.cause, attempt, delayMs, orders: items.length },
          'Saving orders failed, retrying',
        );
        await sleep(delayMs, undefined, { signal: this.stopController.signal }).catch(
          () => undefined,
        );
      }
    }
  }

  private settle({ channel, message }: Delivery, settlement: Settlement): void {
    try {
      if (settlement === 'ack') channel.ack(message);
      else channel.nack(message, false, settlement === 'requeue');
    } catch (error) {
      // The channel closed (for example on a reconnect) after the message arrived. RabbitMQ
      // delivers it again, and the duplicate is skipped when saved.
      this.options.logger.warn({ err: error }, 'Could not settle a message on a closed channel');
    }
  }
}
