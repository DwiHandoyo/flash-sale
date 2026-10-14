import { connect } from 'amqplib';
import { Redis } from 'ioredis';

import { TEST_RABBITMQ_URL, TEST_REDIS_URL } from './infra';

/** Fail early with a clear message when the infrastructure is not running. */
export default async function checkInfrastructure(): Promise<void> {
  const hint = 'Start it with `npm run infra:up` from the repository root.';

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    throw new Error(`Redis is not reachable at ${TEST_REDIS_URL}. ${hint}`, { cause: error });
  } finally {
    redis.disconnect();
  }

  try {
    const connection = await connect(TEST_RABBITMQ_URL);
    await connection.close();
  } catch (error) {
    throw new Error(`RabbitMQ is not reachable at ${TEST_RABBITMQ_URL}. ${hint}`, { cause: error });
  }
}
