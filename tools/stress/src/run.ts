/**
 * Runs a stress test against the whole system in Docker, then checks Redis, PostgreSQL and
 * RabbitMQ directly (docs/09, "Stress test"). Exits with 1 when a check fails.
 *
 *   npm run stress -- [--users 10000] [--stock 100] [--connections 500] [--double-click 0.1]
 *                     [--pollers 0]
 *                     [--chaos kill-api|kill-worker|stop-postgres|restart-redis|wipe-redis]
 *                     [--chaos-after 1000]
 *
 * Steps: build and start the stack → reset the sale → the load generator (inside Docker) waits
 * for the opening and fires, while the optional fault is injected → wait until the workers have
 * saved every order (reconciling first if some reservation has no order) → check.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { readSaleId, readServiceUrl } from '@flash-sale/shared/config';
import { createPgPool, OrderRepository, SaleRepository } from '@flash-sale/shared/postgres';
import { DEAD_LETTER_QUEUE, ORDERS_QUEUE } from '@flash-sale/shared/rabbitmq';
import { decodeBuyerRecord, SALE_FIELDS, saleKeys } from '@flash-sale/shared/redis-keys';
import { connect } from 'amqplib';
import { Redis } from 'ioredis';

import { CHAOS, isChaosName, type Chaos } from './chaos';
import { compose } from './docker';
import type { LoadResult } from './load-result';
import { formatReport } from './report';
import { checkRun, type RunFacts } from './verify';

// ---- Options ---------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    users: { type: 'string', default: '10000' },
    stock: { type: 'string' },
    connections: { type: 'string', default: '500' },
    'double-click': { type: 'string', default: '0.1' },
    pollers: { type: 'string', default: '0' },
    chaos: { type: 'string' },
    'chaos-after': { type: 'string', default: '1000' },
  },
});

function positiveInt(name: string, raw: string, min = 1): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) fail(`--${name} must be a whole number ≥ ${min}`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const users = positiveInt('users', values.users);
const connections = positiveInt('connections', values.connections);
const pollers = positiveInt('pollers', values.pollers, 0);
const chaosAfterMs = positiveInt('chaos-after', values['chaos-after']);
const doubleClickShare = Number(values['double-click']);
if (!(doubleClickShare >= 0 && doubleClickShare <= 1)) fail('--double-click must be from 0 to 1');

let chaos: Chaos | undefined;
if (values.chaos !== undefined) {
  if (!isChaosName(values.chaos)) fail(`--chaos must be one of: ${Object.keys(CHAOS).join(', ')}`);
  chaos = CHAOS[values.chaos];
}
// A fault only shows something while units are still being sold, so chaos runs sell more units
// by default: half the users get one.
const stock =
  values.stock !== undefined
    ? positiveInt('stock', values.stock)
    : chaos
      ? Math.ceil(users / 2)
      : 100;
const doubleClickers = Math.floor(users * doubleClickShare);

// The sale opens this long after the reset: enough to start the load generator and connect.
const OPENS_IN_SECONDS = 15;
const SAVE_TIMEOUT_MS = 120_000;
// No progress for this long means the remaining reservations have no message to save. Longer
// than a worker's longest pause between retries (WORKER_MAX_RETRY_DELAY_MS, 10 s).
const STALLED_AFTER_MS = 15_000;

// The data stores, through the ports Docker Compose publishes on this machine.
const env = process.env;
const saleId = readSaleId(env);
const redis = new Redis(
  readServiceUrl(env, 'REDIS_URL', 'REDIS_PASSWORD', 'redis://localhost:16379'),
  { lazyConnect: true, maxRetriesPerRequest: null },
);
const pool = createPgPool(
  readServiceUrl(
    env,
    'DATABASE_URL',
    'DATABASE_PASSWORD',
    'postgres://flash:flash@localhost:15432/flash_sale',
  ),
  2,
);
const rabbitMqUrl = readServiceUrl(
  env,
  'RABBITMQ_URL',
  'RABBITMQ_PASSWORD',
  'amqp://flash:flash@localhost:5672',
);
// A fault may stop Redis or PostgreSQL for a while; their clients reconnect by themselves.
redis.on('error', () => undefined);
pool.on('error', () => undefined);

const started = Date.now();
const step = (message: string) =>
  console.log(`[${((Date.now() - started) / 1_000).toFixed(1).padStart(5)} s] ${message}`);

// ---- Steps -----------------------------------------------------------------------------------

async function runLoad(): Promise<{ load: LoadResult; fault?: Promise<void> }> {
  let fault: Promise<void> | undefined;
  const output = await compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'stress',
      `--users=${users}`,
      `--connections=${connections}`,
      `--double-click=${doubleClickShare}`,
      `--pollers=${pollers}`,
    ],
    {
      onStderrLine: (line) => {
        const event = parseEvent(line);
        if (event?.event === 'waiting') {
          step(
            `${n(connections)} connections open; firing in ${Number(event.secondsUntilOpen).toFixed(1)} s`,
          );
        } else if (event?.event === 'started') {
          step(`The sale is open: ${n(Number(event.requests))} clicks fired`);
          if (chaos) fault = injectFault(chaos);
        } else if (event?.event === 'progress') {
          step(`  ${n(Number(event.answered))} answered`);
        }
      },
    },
  );
  const lastLine = output.trim().split('\n').at(-1) ?? '';
  return { load: JSON.parse(lastLine) as LoadResult, fault };
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{"event"')) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function injectFault({ description, inject, outageMs, heal }: Chaos): Promise<void> {
  await sleep(chaosAfterMs);
  step(`Fault: ${description}`);
  await inject();
  await sleep(outageMs);
  await heal();
  step('Fault healed');
}

/**
 * Waits until the workers have saved every order they were sent: either every reservation in Redis
 * has its order in PostgreSQL, or the queue is empty and nothing more arrives.
 */
async function waitForWorkers(): Promise<{ buyers: number; saved: number }> {
  const keys = saleKeys(saleId);
  const orders = new OrderRepository(pool);
  const connection = await connect(rabbitMqUrl);
  try {
    const channel = await connection.createChannel();
    const deadline = Date.now() + SAVE_TIMEOUT_MS;
    let lastSaved = -1;
    let lastProgressAt = Date.now();
    for (let polls = 0; ; polls++) {
      const [buyers, saved, { messageCount: waiting }] = await Promise.all([
        redis.hlen(keys.buyers),
        orders.countBySale(saleId),
        channel.checkQueue(ORDERS_QUEUE),
      ]);
      if (buyers === saved && waiting === 0) return { buyers, saved };
      if (saved !== lastSaved) [lastSaved, lastProgressAt] = [saved, Date.now()];
      if (waiting === 0 && Date.now() - lastProgressAt > STALLED_AFTER_MS) {
        return { buyers, saved };
      }
      if (Date.now() > deadline) {
        step(`Gave up waiting: ${buyers} buyers in Redis, ${saved} orders saved; checking anyway`);
        return { buyers, saved };
      }
      if (polls % 10 === 0) step(`  ${n(saved)} of ${n(buyers)} orders saved`);
      await sleep(500);
    }
  } finally {
    await connection.close();
  }
}

async function readFacts(load: LoadResult): Promise<RunFacts & { appendfsync: string }> {
  const keys = saleKeys(saleId);
  const [sale, orders, buyers, remainingStock, fsyncConfig, queues] = await Promise.all([
    new SaleRepository(pool).find(saleId),
    new OrderRepository(pool).listBySale(saleId),
    redis.hgetall(keys.buyers),
    redis.hget(keys.sale, SALE_FIELDS.remainingStock),
    redis.config('GET', 'appendfsync') as Promise<string[]>,
    queueDepths(),
  ]);
  if (!sale) throw new Error(`Sale "${saleId}" is missing from PostgreSQL`);

  return {
    users,
    expectSoldOut: chaos?.expectSoldOut ?? true,
    load,
    sale,
    redis: {
      remainingStock: Number(remainingStock),
      buyers: Object.entries(buyers).map(([userId, record]) => decodeBuyerRecord(userId, record)),
    },
    orders,
    queues,
    appendfsync: fsyncConfig[1] ?? 'unknown',
  };
}

async function queueDepths(): Promise<RunFacts['queues']> {
  const connection = await connect(rabbitMqUrl);
  try {
    const channel = await connection.createChannel();
    const [orders, deadLetters] = await Promise.all([
      channel.checkQueue(ORDERS_QUEUE),
      channel.checkQueue(DEAD_LETTER_QUEUE),
    ]);
    return { orders: orders.messageCount, deadLetters: deadLetters.messageCount };
  } finally {
    await connection.close();
  }
}

const n = (value: number) => value.toLocaleString('en-US');

// ---- Main ------------------------------------------------------------------------------------

try {
  step('Building the images (cached after the first time)');
  await compose(['--profile', 'manual', 'build']);
  step('Starting the system');
  await compose(['up', '-d', '--wait']);
  await redis.connect();

  step(`Resetting the sale: ${n(stock)} units, opening in ${OPENS_IN_SECONDS} s`);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'jobs',
    'reset',
    `--stock=${stock}`,
    `--starts-in=${OPENS_IN_SECONDS}`,
    '--duration=1800',
  ]);

  step(
    `Starting ${n(users)} users (${n(doubleClickers)} double-click) on ${n(connections)} connections` +
      (pollers > 0 ? `, plus ${n(pollers)} pollers` : ''),
  );
  const { load, fault } = await runLoad();
  step(`Load finished in ${(load.durationMs / 1_000).toFixed(2)} s`);
  await fault;

  step('Waiting for the workers to save every order');
  const { buyers, saved } = await waitForWorkers();
  if (buyers !== saved) {
    // Reservations whose publish was never confirmed: reconciliation completes them, as the
    // scheduler does at endsAt (docs/06).
    step(`${n(buyers - saved)} reservations have no order yet; reconciling`);
    await compose(['run', '--rm', '--no-deps', '-T', 'jobs', 'reconcile']);
    await waitForWorkers();
  }

  const { appendfsync, ...facts } = await readFacts(load);
  const checks = checkRun(facts);
  console.log(
    formatReport({
      fault: values.chaos ? `${values.chaos}: ${chaos?.description}` : 'none',
      stock,
      doubleClickers,
      appendfsync,
      load,
      checks,
    }),
  );
  process.exitCode = checks.every((check) => check.passed) ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  redis.disconnect();
  await pool.end();
}
