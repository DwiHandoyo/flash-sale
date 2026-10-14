import type { OrderMessage } from './order';

/**
 * RabbitMQ topology for orders. Kept as plain data, without a client library, so every app can
 * use it. The bootstrap job declares the queues; the API publishes and the worker consumes.
 */
export const ORDERS_QUEUE = 'orders';
export const DEAD_LETTER_QUEUE = 'orders.dead-letter';

/** A message that fails this many deliveries moves to the dead-letter queue. */
export const MAX_DELIVERIES = 10;

export const ordersQueueArguments = {
  // Replicated across the nodes of a cluster; a publisher confirm means a majority stored it.
  'x-queue-type': 'quorum',
  'x-delivery-limit': MAX_DELIVERIES,
  // '' is the default exchange, which routes by queue name.
  'x-dead-letter-exchange': '',
  'x-dead-letter-routing-key': DEAD_LETTER_QUEUE,
} as const;

export const deadLetterQueueArguments = { 'x-queue-type': 'quorum' } as const;

/** Publish options for an order message. The message ID is the order ID, so duplicates stand out. */
export function orderPublishOptions(message: OrderMessage) {
  return {
    messageId: message.orderId,
    contentType: 'application/json',
    persistent: true,
  } as const;
}
