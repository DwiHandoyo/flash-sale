import { createPgPool, migrate } from '@flash-sale/shared/postgres';
import { connect } from 'amqplib';

import { TEST_DATABASE_URL, TEST_RABBITMQ_URL } from './infra';

/** Fails early with a clear message when the infrastructure is not running, then applies the schema. */
export default async function prepareInfrastructure(): Promise<void> {
  const hint = 'Start it with `npm run infra:up` from the repository root.';

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
    const connection = await connect(TEST_RABBITMQ_URL);
    await connection.close();
  } catch (error) {
    throw new Error(`RabbitMQ is not reachable at ${TEST_RABBITMQ_URL}. ${hint}`, { cause: error });
  }
}
