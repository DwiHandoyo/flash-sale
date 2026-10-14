import { createPgPool, migrate } from '@flash-sale/shared/postgres';
import { connect } from 'amqplib';
import { Redis } from 'ioredis';

import { TEST_DATABASE_URL, TEST_RABBITMQ_URL, TEST_REDIS_URL } from './infra';

/** Fails early with a clear message when the infrastructure is not running, then applies the schema. */
export default async function prepareInfrastructure(): Promise<void> {
  const hint = 'Start it with `npm run infra:up` from the repository root.';

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await redis.connect();
  } catch (error) {
    throw new Error(`Redis is not reachable at ${TEST_REDIS_URL}. ${hint}`, { cause: error });
  } finally {
    redis.disconnect();
  }

  const pool = createPgPool(TEST_DATABASE_URL, 1);
  try {
    await migrate(pool);
  } catch (error) {
    throw new Error(`PostgreSQL is not reachable at ${TEST_DATABASE_URL}. ${hint}`, {
      cause: error,
    });
  } finally {
    await pool.end();
  }

  try {
    await (await connect(TEST_RABBITMQ_URL)).close();
  } catch (error) {
    throw new Error(`RabbitMQ is not reachable at ${TEST_RABBITMQ_URL}. ${hint}`, { cause: error });
  }
}
