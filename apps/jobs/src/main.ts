/**
 * Command-line entry point for the jobs:
 *   bootstrap   prepare the database, queues and Redis (run before the API starts)
 *   reconcile   publish reservations that have no order record yet
 *   recover     rebuild Redis from PostgreSQL after Redis lost data
 *   reset       restart the sale with full stock: --stock 100 --starts-in 30 --duration 3600
 *   schedule    keep running and reconcile at endsAt (local stand-in for EventBridge Scheduler)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { exitOnSignal } from '@flash-sale/shared/lifecycle';
import { createLogger } from '@flash-sale/shared/logger';
import { RabbitMqOrderPublisher } from '@flash-sale/shared/order-publisher';
import {
  createPgPool,
  migrate,
  OrderRepository,
  SaleRepository,
  withTransaction,
} from '@flash-sale/shared/postgres';
import { createRedisClient, waitForRedis } from '@flash-sale/shared/redis-client';

import { RabbitMqQueueAdmin } from './adapters/rabbitmq/rabbitmq-queue-admin';
import { RedisSaleStateStore } from './adapters/redis/redis-sale-state-store';
import { bootstrap } from './app/bootstrap';
import type { JobDependencies } from './app/ports';
import { reconcile } from './app/reconcile';
import { recover } from './app/recover';
import { resetSale } from './app/reset-sale';
import { runScheduler } from './app/schedule';
import { loadConfig, loadSaleDefinition } from './config';

const COMMANDS = ['bootstrap', 'reconcile', 'recover', 'reset', 'schedule'] as const;
type Command = (typeof COMMANDS)[number];

const command = process.argv[2] as Command | undefined;
if (!command || !COMMANDS.includes(command)) {
  console.error(`Usage: jobs <${COMMANDS.join('|')}> [options]`);
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger(`jobs:${command}`, config.logLevel);
const stop = new AbortController();

const redis = createRedisClient(config.redisUrl, { connectionName: `jobs-${command}` });
redis.on('error', (error: Error) => logger.warn({ err: error }, 'Redis connection error'));
const pool = createPgPool(config.databaseUrl, 2);
pool.on('error', (error) => logger.warn({ err: error }, 'PostgreSQL connection error'));
const publisher = new RabbitMqOrderPublisher({
  url: config.rabbitMqUrl,
  confirmTimeoutMs: config.publishConfirmTimeoutMs,
  logger,
});

const deps: JobDependencies = {
  saleId: config.saleId,
  logger,
  sales: new SaleRepository(pool),
  orders: new OrderRepository(pool),
  saleState: new RedisSaleStateStore(redis, config.saleId),
  queues: new RabbitMqQueueAdmin({
    amqpUrl: config.rabbitMqUrl,
    managementUrl: config.rabbitMqManagementUrl,
  }),
  publisher,
  migrate: () => migrate(pool),
  resetPersistedSale: (sale) =>
    withTransaction(pool, async (client) => {
      await new SaleRepository(client).reset(sale);
      await new OrderRepository(client).deleteBySale(sale.id);
    }),
  drain: { settleMs: config.drainSettleMs, timeoutMs: config.drainTimeoutMs, pollMs: 500 },
  clock: Date.now,
  sleep: (ms) => sleep(ms, undefined, { signal: stop.signal }).catch(() => undefined),
};

async function run(): Promise<void> {
  await waitForRedis(redis);
  if (command !== 'reset' && command !== 'recover') await publisher.start();

  switch (command) {
    case 'bootstrap':
      return bootstrap(deps, loadSaleDefinition());
    case 'reconcile':
      await reconcile(deps);
      return;
    case 'recover':
      await recover(deps);
      return;
    case 'reset':
      return resetSale(deps, loadSaleDefinition(resetOverrides()));
    case 'schedule':
      exitOnSignal(logger, async () => stop.abort());
      return runScheduler(deps, {
        intervalMs: config.scheduleIntervalMs,
        retryDelayMs: config.reconcileRetryDelayMs,
        signal: stop.signal,
      });
  }
}

/** `reset` flags override the SALE_* variables and reuse their validation. */
function resetOverrides(): NodeJS.ProcessEnv {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      stock: { type: 'string' },
      'starts-in': { type: 'string' },
      duration: { type: 'string' },
    },
  });
  const env = { ...process.env };
  if (values.stock !== undefined) env.SALE_TOTAL_STOCK = values.stock;
  if (values['starts-in'] !== undefined) {
    env.SALE_START_DELAY_SECONDS = values['starts-in'];
    delete env.SALE_STARTS_AT;
  }
  if (values.duration !== undefined) {
    env.SALE_DURATION_SECONDS = values.duration;
    delete env.SALE_ENDS_AT;
  }
  return env;
}

try {
  await run();
} catch (error) {
  logger.error({ err: error }, `${command} failed`);
  process.exitCode = 1;
} finally {
  await publisher.close().catch(() => undefined);
  await pool.end();
  redis.disconnect();
}
