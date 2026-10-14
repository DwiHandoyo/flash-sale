/** Composition root: builds the API from its parts and starts it. */
import { randomUUID } from 'node:crypto';

import { exitOnSignal } from '@flash-sale/shared/lifecycle';
import { createLogger } from '@flash-sale/shared/logger';
import { RabbitMqOrderPublisher } from '@flash-sale/shared/order-publisher';
import { createRedisClient, waitForRedis } from '@flash-sale/shared/redis-client';

import { buildApp } from './adapters/http/app';
import { RedisSaleStore } from './adapters/redis/redis-sale-store';
import { CachedValue } from './app/cached-value';
import { createUseCases } from './app/use-cases';
import { loadConfig } from './config';

const config = loadConfig();
const logger = createLogger('api', config.logLevel);

const redis = createRedisClient(config.redisUrl, {
  connectionName: 'api',
  failFast: true,
  commandTimeoutMs: config.redisCommandTimeoutMs,
});
redis.on('error', (error: Error) => logger.warn({ err: error }, 'Redis connection error'));

const saleStore = new RedisSaleStore(redis, config.saleId);
const publisher = new RabbitMqOrderPublisher({
  url: config.rabbitMqUrl,
  confirmTimeoutMs: config.publishConfirmTimeoutMs,
  logger,
});

const useCases = createUseCases({
  saleId: config.saleId,
  saleStore,
  publisher,
  saleState: new CachedValue(() => saleStore.getState(), config.stateCacheTtlMs),
  clock: Date.now,
  newOrderId: randomUUID,
});

const app = await buildApp({
  useCases,
  logger,
  logRequests: config.logRequests,
  maxEventLoopDelayMs: config.maxEventLoopDelayMs,
  isReady: async () =>
    redis.status === 'ready' && publisher.isReady() && (await redis.ping()) === 'PONG',
});

await Promise.all([waitForRedis(redis), publisher.start()]);
await app.listen({ host: config.host, port: config.port });

exitOnSignal(logger, async () => {
  // Stop taking connections and let in-flight requests finish, then close the clients.
  await app.close();
  await publisher.close();
  await redis.quit();
});
