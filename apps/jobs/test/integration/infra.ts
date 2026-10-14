import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { OrderQueues } from '@flash-sale/shared/rabbitmq';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:16379/1';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://flash:flash@localhost:15432/flash_sale_test';
export const TEST_RABBITMQ_URL =
  process.env.TEST_RABBITMQ_URL ?? 'amqp://flash:flash@localhost:5672';
export const TEST_RABBITMQ_MANAGEMENT_URL =
  process.env.TEST_RABBITMQ_MANAGEMENT_URL ?? 'http://flash:flash@localhost:15672';

export function uniqueQueues(): OrderQueues {
  const name = `test-orders-${randomUUID().slice(0, 8)}`;
  return { orders: name, deadLetter: `${name}.dead-letter` };
}

/** Polls until `check` returns true, or fails after `timeoutMs`. */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await sleep(100);
  }
}
