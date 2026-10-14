import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { OrderMessage } from '@flash-sale/shared/order';
import type { OrderQueues } from '@flash-sale/shared/rabbitmq';

/** A separate database, so tests never touch the demo data. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://flash:flash@localhost:15432/flash_sale_test';
export const TEST_RABBITMQ_URL =
  process.env.TEST_RABBITMQ_URL ?? 'amqp://flash:flash@localhost:5672';

export function uniqueQueues(): OrderQueues {
  const name = `test-orders-${randomUUID().slice(0, 8)}`;
  return { orders: name, deadLetter: `${name}.dead-letter` };
}

export function orderMessage(saleId: string, overrides: Partial<OrderMessage> = {}): OrderMessage {
  return {
    orderId: randomUUID(),
    saleId,
    userId: `user-${randomUUID().slice(0, 8)}`,
    purchasedAt: Date.now(),
    ...overrides,
  };
}

/** Polls until `check` returns true, or fails after `timeoutMs`. */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await sleep(50);
  }
}
