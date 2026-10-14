import type { Channel } from 'amqplib';

import type { OrderMessage } from './order';

/**
 * RabbitMQ topology for orders, in one place for every app. It needs no client library at
 * runtime (the amqplib import is type-only).
 */
export const ORDERS_QUEUE = 'orders';
export const DEAD_LETTER_QUEUE = 'orders.dead-letter';

/** A message that fails this many deliveries moves to the dead-letter queue. */
export const MAX_DELIVERIES = 10;

export interface OrderQueues {
  readonly orders: string;
  readonly deadLetter: string;
}

export const DEFAULT_ORDER_QUEUES: OrderQueues = {
  orders: ORDERS_QUEUE,
  deadLetter: DEAD_LETTER_QUEUE,
};

/**
 * Declares both queues. Idempotent: the bootstrap job and the worker both call it on start-up.
 * - Quorum queues are replicated across the nodes of a cluster: a publisher confirm means a
 *   majority stored the message.
 * - A message rejected without requeue, or delivered MAX_DELIVERIES times, is dead-lettered.
 */
export async function declareOrderTopology(
  channel: Channel,
  queues: OrderQueues = DEFAULT_ORDER_QUEUES,
): Promise<void> {
  await channel.assertQueue(queues.deadLetter, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.assertQueue(queues.orders, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': MAX_DELIVERIES,
      // '' is the default exchange, which routes by queue name.
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': queues.deadLetter,
    },
  });
}

/** Publish options for an order message. The message ID is the order ID, so duplicates stand out. */
export function orderPublishOptions(message: OrderMessage) {
  return {
    messageId: message.orderId,
    contentType: 'application/json',
    persistent: true,
  } as const;
}
