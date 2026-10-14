/** A unit reserved for one user. */
export interface Order {
  readonly orderId: string;
  readonly userId: string;
  /** Epoch milliseconds, from the Redis clock at the moment of the reservation. */
  readonly purchasedAt: number;
}

/**
 * The message that carries an order through RabbitMQ: published by the API (and by the
 * reconcile job), consumed by the worker. Both sides use this module, so they cannot disagree.
 */
export interface OrderMessage extends Order {
  readonly saleId: string;
}

export class InvalidOrderMessageError extends Error {
  override name = 'InvalidOrderMessageError';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeOrderMessage(message: OrderMessage): Buffer {
  const { orderId, saleId, userId, purchasedAt } = message;
  return Buffer.from(JSON.stringify({ orderId, saleId, userId, purchasedAt }));
}

export function decodeOrderMessage(content: Buffer): OrderMessage {
  let value: unknown;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch {
    throw new InvalidOrderMessageError('Order message is not valid JSON');
  }

  const { orderId, saleId, userId, purchasedAt } = (value ?? {}) as Record<string, unknown>;
  if (typeof orderId !== 'string' || !UUID_PATTERN.test(orderId)) {
    throw new InvalidOrderMessageError('orderId must be a UUID');
  }
  if (typeof saleId !== 'string' || saleId === '') {
    throw new InvalidOrderMessageError('saleId must be a non-empty string');
  }
  if (typeof userId !== 'string' || userId === '') {
    throw new InvalidOrderMessageError('userId must be a non-empty string');
  }
  if (typeof purchasedAt !== 'number' || !Number.isSafeInteger(purchasedAt) || purchasedAt <= 0) {
    throw new InvalidOrderMessageError('purchasedAt must be a positive integer (epoch ms)');
  }
  return { orderId, saleId, userId, purchasedAt };
}
