import { readInt, readServiceUrl, readString, type Env } from '@flash-sale/shared/config';

export interface WorkerConfig {
  readonly logLevel: string;
  readonly rabbitMqUrl: string;
  readonly databaseUrl: string;
  readonly prefetch: number;
  readonly batchWindowMs: number;
  readonly maxRetryDelayMs: number;
}

/** Defaults match the local Docker Compose setup. */
export function loadConfig(env: Env = process.env): WorkerConfig {
  return {
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    rabbitMqUrl: readServiceUrl(
      env,
      'RABBITMQ_URL',
      'RABBITMQ_PASSWORD',
      'amqp://flash:flash@localhost:5672',
    ),
    databaseUrl: readServiceUrl(
      env,
      'DATABASE_URL',
      'DATABASE_PASSWORD',
      'postgres://flash:flash@localhost:15432/flash_sale',
    ),
    prefetch: readInt(env, 'WORKER_PREFETCH', 100, { min: 1, max: 1_000 }),
    batchWindowMs: readInt(env, 'WORKER_BATCH_WINDOW_MS', 50, { min: 0 }),
    maxRetryDelayMs: readInt(env, 'WORKER_MAX_RETRY_DELAY_MS', 10_000, { min: 100 }),
  };
}
