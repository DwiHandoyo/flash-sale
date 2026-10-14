import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type RecoveringChannelModel,
} from 'amqplib';

import { DependencyUnavailableError } from './errors';
import type { Logger } from './logger';
import { encodeOrderMessage, type OrderMessage } from './order';
import { ORDERS_QUEUE, orderPublishOptions } from './rabbitmq';

export interface OrderPublisherOptions {
  readonly url: string;
  readonly logger: Logger;
  /** How long to wait for RabbitMQ to confirm a message before giving up. */
  readonly confirmTimeoutMs: number;
  readonly queue?: string;
  /** Reconnect attempts before giving up at start-up; after that, it reconnects forever. */
  readonly startupRetries?: number;
}

/**
 * Publishes orders and resolves only once RabbitMQ confirms it has stored them. Used by the API
 * (new orders) and the reconcile job (re-publishing).
 *
 * - Publisher confirms: a resolved publish means the broker has the message.
 * - `mandatory`: a message that reaches no queue (for example, the queue was never declared)
 *   is returned by the broker before its confirm, so it counts as a failure, never as stored.
 * - Automatic reconnection (amqplib recovery). While disconnected, publishing fails at once.
 */
export class RabbitMqOrderPublisher {
  private connection: RecoveringChannelModel | undefined;
  private model: ChannelModel | undefined;
  private channel: Promise<ConfirmChannel> | undefined;
  /** Message IDs the broker returned as unroutable, waiting for their confirm. */
  private readonly returned = new Map<string, number>();
  private readonly queue: string;

  constructor(private readonly options: OrderPublisherOptions) {
    this.queue = options.queue ?? ORDERS_QUEUE;
  }

  async start(): Promise<void> {
    const { logger, startupRetries = 15 } = this.options;
    this.connection = await connect(this.options.url, {
      recovery: {
        initialDelay: 200,
        maxDelay: 2_000,
        initialMaxRetries: startupRetries,
        maxRetries: Infinity,
        setup: (model: ChannelModel) => {
          this.model = model;
          this.channel = undefined;
          return Promise.resolve();
        },
      },
    });
    this.connection.on('connect', () => logger.info('Connected to RabbitMQ'));
    this.connection.on('disconnect', (error: Error) => {
      this.model = undefined;
      this.channel = undefined;
      logger.warn({ err: error }, 'Disconnected from RabbitMQ, reconnecting');
    });
    this.connection.on('error', (error: Error) => logger.warn({ err: error }, 'RabbitMQ error'));
  }

  isReady(): boolean {
    return this.model !== undefined;
  }

  async publish(message: OrderMessage): Promise<void> {
    const channel = await this.getChannel();
    const { confirmTimeoutMs } = this.options;

    await new Promise<void>((resolve, reject) => {
      const fail = (cause: unknown) => reject(new DependencyUnavailableError('rabbitmq', cause));
      const timer = setTimeout(
        () => fail(new Error(`No publisher confirm within ${confirmTimeoutMs} ms`)),
        confirmTimeoutMs,
      );
      try {
        channel.sendToQueue(
          this.queue,
          encodeOrderMessage(message),
          { ...orderPublishOptions(message), mandatory: true },
          (error: unknown) => {
            clearTimeout(timer);
            if (error) return fail(error);
            if (this.takeReturned(message.orderId)) {
              return fail(new Error(`Queue "${this.queue}" does not exist`));
            }
            resolve();
          },
        );
      } catch (error) {
        // The channel closed between getChannel() and sendToQueue().
        clearTimeout(timer);
        fail(error);
      }
    });
  }

  async close(): Promise<void> {
    await this.connection?.close();
  }

  private getChannel(): Promise<ConfirmChannel> {
    const model = this.model;
    if (!model) {
      return Promise.reject(
        new DependencyUnavailableError('rabbitmq', new Error('Not connected to RabbitMQ')),
      );
    }
    // One confirm channel, opened lazily and shared by all publishes.
    this.channel ??= model.createConfirmChannel().then((channel) => {
      channel.on('return', (message) => this.markReturned(String(message.properties.messageId)));
      channel.on('error', (error: Error) =>
        this.options.logger.warn({ err: error }, 'RabbitMQ channel error'),
      );
      channel.on('close', () => {
        this.channel = undefined;
      });
      return channel;
    });
    this.channel.catch(() => {
      this.channel = undefined;
    });
    return this.channel.catch((error: unknown) => {
      throw new DependencyUnavailableError('rabbitmq', error);
    });
  }

  private markReturned(messageId: string): void {
    this.returned.set(messageId, (this.returned.get(messageId) ?? 0) + 1);
  }

  private takeReturned(messageId: string): boolean {
    const count = this.returned.get(messageId);
    if (!count) return false;
    if (count === 1) this.returned.delete(messageId);
    else this.returned.set(messageId, count - 1);
    return true;
  }
}
