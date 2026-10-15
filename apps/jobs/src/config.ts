import {
  ConfigError,
  readInt,
  readSaleId,
  readServiceUrl,
  readString,
  readTimestamp,
  type Env,
} from '@flash-sale/shared/config';
import type { SaleDefinition } from '@flash-sale/shared/sale';

export interface JobsConfig {
  readonly logLevel: string;
  readonly saleId: string;
  readonly redisUrl: string;
  readonly databaseUrl: string;
  readonly rabbitMqUrl: string;
  /** RabbitMQ's HTTP management API, used to see how many orders are still in flight. */
  readonly rabbitMqManagementUrl: string;
  readonly publishConfirmTimeoutMs: number;
  /**
   * How long recovery ignores queue readings after pausing the sale. Must exceed the age of
   * RabbitMQ's sampled counts (about 2 s locally, up to about 10 s with default settings) plus
   * the publish confirm timeout. See waitUntilDrained.
   */
  readonly drainSettleMs: number;
  readonly drainTimeoutMs: number;
  /** How often the local scheduler checks whether reconciliation is due. */
  readonly scheduleIntervalMs: number;
  /** The second reconciliation runs this long after `endsAt`, in case the first one failed. */
  readonly reconcileRetryDelayMs: number;
  /** GET /api/sale behind the CDN, refreshed after reset and recover. Empty: no CDN to refresh. */
  readonly cdnRefreshUrl: string;
}

/** Defaults match the local Docker Compose setup. */
export function loadConfig(env: Env = process.env): JobsConfig {
  return {
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    saleId: readSaleId(env),
    redisUrl: readServiceUrl(env, 'REDIS_URL', 'REDIS_PASSWORD', 'redis://localhost:16379'),
    databaseUrl: readServiceUrl(
      env,
      'DATABASE_URL',
      'DATABASE_PASSWORD',
      'postgres://flash:flash@localhost:15432/flash_sale',
    ),
    rabbitMqUrl: readServiceUrl(
      env,
      'RABBITMQ_URL',
      'RABBITMQ_PASSWORD',
      'amqp://flash:flash@localhost:5672',
    ),
    rabbitMqManagementUrl: readServiceUrl(
      env,
      'RABBITMQ_MANAGEMENT_URL',
      'RABBITMQ_PASSWORD',
      'http://flash:flash@localhost:15672',
    ),
    publishConfirmTimeoutMs: readInt(env, 'PUBLISH_CONFIRM_TIMEOUT_MS', 2_000, { min: 1 }),
    drainSettleMs: readInt(env, 'DRAIN_SETTLE_MS', 5_000, { min: 0 }),
    drainTimeoutMs: readInt(env, 'DRAIN_TIMEOUT_MS', 300_000, { min: 1 }),
    scheduleIntervalMs: readInt(env, 'SCHEDULE_INTERVAL_MS', 15_000, { min: 100 }),
    reconcileRetryDelayMs: readInt(env, 'RECONCILE_RETRY_DELAY_MS', 300_000, { min: 0 }),
    cdnRefreshUrl: readString(env, 'CDN_REFRESH_URL', ''),
  };
}

/**
 * The sale to create on first boot. Absolute times (SALE_STARTS_AT / SALE_ENDS_AT, ISO 8601) win
 * over relative ones. The relative defaults make demos easy: the sale opens 30 seconds after
 * bootstrap and runs for an hour.
 */
export function loadSaleDefinition(env: Env = process.env, now = Date.now()): SaleDefinition {
  const startsAt =
    readTimestamp(env, 'SALE_STARTS_AT') ??
    now + readInt(env, 'SALE_START_DELAY_SECONDS', 30, { min: 0 }) * 1_000;
  const endsAt =
    readTimestamp(env, 'SALE_ENDS_AT') ??
    startsAt + readInt(env, 'SALE_DURATION_SECONDS', 3_600, { min: 1 }) * 1_000;

  if (endsAt <= startsAt) throw new ConfigError('The sale must end after it starts.');

  return {
    id: readSaleId(env),
    totalStock: readInt(env, 'SALE_TOTAL_STOCK', 100, { min: 0 }),
    startsAt,
    endsAt,
  };
}
