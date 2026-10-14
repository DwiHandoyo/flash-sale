/** Composition root: consumes orders from RabbitMQ and saves them into PostgreSQL. */
import { exitOnSignal } from '@flash-sale/shared/lifecycle';
import { createLogger } from '@flash-sale/shared/logger';
import { createPgPool, OrderRepository } from '@flash-sale/shared/postgres';

import { RabbitMqOrderConsumer } from './adapters/rabbitmq/order-consumer';
import { createSaveOrders } from './app/save-orders';
import { loadConfig } from './config';

const config = loadConfig();
const logger = createLogger('worker', config.logLevel);

const pool = createPgPool(config.databaseUrl);
// Idle clients emit 'error' when PostgreSQL restarts. Unhandled, that would crash the worker.
pool.on('error', (error) => logger.warn({ err: error }, 'PostgreSQL connection error'));

const saveOrders = createSaveOrders(new OrderRepository(pool));

const consumer = new RabbitMqOrderConsumer({
  url: config.rabbitMqUrl,
  logger,
  prefetch: config.prefetch,
  batchWindowMs: config.batchWindowMs,
  maxRetryDelayMs: config.maxRetryDelayMs,
  handle: async (messages) => {
    const result = await saveOrders(messages);
    logger.info({ received: messages.length, ...result }, 'Saved orders');
  },
});

await consumer.start();

exitOnSignal(logger, async () => {
  await consumer.stop();
  await pool.end();
});
