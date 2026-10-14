import {
  readBoolean,
  readInt,
  readSaleId,
  readServiceUrl,
  readString,
  type Env,
} from '@flash-sale/shared/config';

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly logRequests: boolean;
  readonly saleId: string;
  readonly redisUrl: string;
  readonly rabbitMqUrl: string;
  /** How long a sale state snapshot may be reused for status responses (0 disables caching). */
  readonly stateCacheTtlMs: number;
  readonly redisCommandTimeoutMs: number;
  readonly publishConfirmTimeoutMs: number;
  /** Event-loop delay above which requests are shed with 503 (0 disables). */
  readonly maxEventLoopDelayMs: number;
}

/** Defaults match the local Docker Compose setup, so `npm run dev` works without a .env file. */
export function loadConfig(env: Env = process.env): ApiConfig {
  return {
    host: readString(env, 'HOST', '0.0.0.0'),
    port: readInt(env, 'PORT', 3000, { min: 0, max: 65_535 }),
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    logRequests: readBoolean(env, 'LOG_REQUESTS', false),
    saleId: readSaleId(env),
    redisUrl: readServiceUrl(env, 'REDIS_URL', 'REDIS_PASSWORD', 'redis://localhost:16379'),
    rabbitMqUrl: readServiceUrl(
      env,
      'RABBITMQ_URL',
      'RABBITMQ_PASSWORD',
      'amqp://flash:flash@localhost:5672',
    ),
    stateCacheTtlMs: readInt(env, 'STATE_CACHE_TTL_MS', 500, { min: 0 }),
    redisCommandTimeoutMs: readInt(env, 'REDIS_COMMAND_TIMEOUT_MS', 2_000, { min: 1 }),
    publishConfirmTimeoutMs: readInt(env, 'PUBLISH_CONFIRM_TIMEOUT_MS', 2_000, { min: 1 }),
    maxEventLoopDelayMs: readInt(env, 'MAX_EVENT_LOOP_DELAY_MS', 1_000, { min: 0 }),
  };
}
