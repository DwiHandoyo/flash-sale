import { Redis, type RedisOptions } from 'ioredis';

export interface RedisClientOptions {
  readonly connectionName?: string;
  /**
   * Fail commands at once while disconnected instead of queueing them. The API uses this, so a
   * Redis outage becomes fast 503s instead of a growing backlog of waiting requests.
   */
  readonly failFast?: boolean;
  readonly commandTimeoutMs?: number;
}

export function createRedisClient(url: string, options: RedisClientOptions = {}): Redis {
  const { connectionName, failFast = false, commandTimeoutMs } = options;
  const redisOptions: RedisOptions = {
    lazyConnect: true,
    // Keep reconnecting with a capped backoff; callers decide what to do in the meantime.
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
    enableOfflineQueue: !failFast,
    maxRetriesPerRequest: failFast ? 0 : null,
  };
  if (connectionName) redisOptions.connectionName = connectionName;
  if (commandTimeoutMs) redisOptions.commandTimeout = commandTimeoutMs;
  return new Redis(url, redisOptions);
}

/** Connects and resolves once Redis accepts commands, retrying until `timeoutMs`. */
export async function waitForRedis(redis: Redis, timeoutMs = 30_000): Promise<void> {
  if (redis.status === 'ready') return;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`Redis was not ready after ${timeoutMs} ms`));
    }, timeoutMs);
    redis.once('ready', onReady);
    if (redis.status === 'wait') {
      // A failed first attempt rejects here, but ioredis keeps retrying via retryStrategy.
      redis.connect().catch(() => undefined);
    }
  });
}
