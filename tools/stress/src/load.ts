/**
 * The load generator, started by `npm run stress` (run.ts). It runs inside the Docker network,
 * because on macOS Docker's port forwarding would be the bottleneck (docs/10, "Stress test setup").
 *
 * It opens its connections, waits for the sale to open, then has every user press "Buy" at that
 * moment, some of them twice. Each connection carries one request at a time, so `connections` is
 * the number of users waiting for an answer at any moment. A user who gets a 5xx or no answer
 * tries again a few times, as a person would. With --pollers, other users meanwhile poll the sale
 * status every 2 s, as the app does, to show how much of it the CDN cache absorbs. Progress goes
 * to stderr; the result is one JSON line on stdout.
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { Pool } from 'undici';

import type { LoadResult } from './load-result';
import { countOutcomes, summarizeLatency, timeline, type Sample } from './stats';

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: process.env.TARGET_URL ?? 'http://web:8080' },
    users: { type: 'string', default: '10000' },
    connections: { type: 'string', default: '500' },
    'double-click': { type: 'string', default: '0.1' },
    retries: { type: 'string', default: '3' },
    pollers: { type: 'string', default: '0' },
  },
});
const users = Number(values.users);
const connections = Number(values.connections);
const doubleClickShare = Number(values['double-click']);
const maxRetries = Number(values.retries);
const pollers = Number(values.pollers);
/** How often each poller asks for the status, like the app (apps/web/src/hooks/useSaleStatus.ts). */
const POLL_INTERVAL_MS = 2_000;

const pool = new Pool(values.target, {
  connections,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: 30_000,
});
// Status polls get their own connections, so they never wait behind purchases.
const pollPool = new Pool(values.target, {
  connections: Math.max(1, Math.min(pollers, 200)),
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: 30_000,
});

const report = (event: Record<string, unknown>) => console.error(JSON.stringify(event));

/** The sale's opening time, translated to this machine's clock. */
async function saleOpensAt(): Promise<number> {
  for (;;) {
    const before = Date.now();
    try {
      const response = await pool.request({ method: 'GET', path: '/api/sale' });
      const after = Date.now();
      if (response.statusCode === 200) {
        const sale = (await response.body.json()) as { startsAt: string; serverTime: string };
        const clockOffset = Date.parse(sale.serverTime) - (before + after) / 2;
        return Date.parse(sale.startsAt) - clockOffset;
      }
      await response.body.dump();
    } catch {
      // The system is still starting.
    }
    await sleep(500);
  }
}

/** Opens every connection now, so the burst does not begin with thousands of TCP handshakes. */
async function warmUp(): Promise<void> {
  await Promise.all(
    Array.from({ length: connections }, async () => {
      const response = await pool.request({ method: 'GET', path: '/api/sale' });
      await response.body.dump();
    }),
  );
}

interface Attempt {
  readonly outcome: string;
  readonly orderId?: string;
  /** Set when the user should try again after this many milliseconds. */
  readonly retryAfterMs?: number;
}

async function purchase(userId: string): Promise<Attempt> {
  try {
    const response = await pool.request({
      method: 'POST',
      path: '/api/purchases',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const text = await response.body.text();
    let body: { code?: string; order?: { orderId?: string } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // For example an HTML error page from nginx.
    }
    const status = response.statusCode;
    const retryAfter = Number(response.headers['retry-after']);
    return {
      outcome: `${status} ${body.code ?? 'non-JSON reply'}`,
      orderId: body.order?.orderId,
      retryAfterMs: status >= 500 ? (retryAfter > 0 ? retryAfter * 1_000 : 1_000) : undefined,
    };
  } catch {
    return { outcome: 'network error', retryAfterMs: 1_000 };
  }
}

/** One entry per click: the double-clicking users appear twice in a row. */
function clicks(): string[] {
  const list: string[] = [];
  for (let i = 0; i < users; i++) {
    const userId = `user-${String(i + 1).padStart(6, '0')}`;
    list.push(userId);
    // Spread the double clickers evenly: exactly floor(users * share) of them.
    if (Math.floor((i + 1) * doubleClickShare) > Math.floor(i * doubleClickShare)) {
      list.push(userId);
    }
  }
  return list;
}

const opensAt = await saleOpensAt();
await warmUp();
// Fire a moment after the opening, so clock estimates never make the first users too early.
const fireAt = opensAt + 100;
report({ event: 'waiting', secondsUntilOpen: Math.max(0, (fireAt - Date.now()) / 1_000) });
await sleep(Math.max(0, fireAt - Date.now()));

const queue = clicks();
const samples: Sample[] = [];
const ordersByUser = new Map<string, Set<string>>();
const startedAt = performance.now();
report({ event: 'started', requests: queue.length });

const progress = setInterval(() => {
  report({ event: 'progress', elapsedMs: performance.now() - startedAt, answered: samples.length });
}, 1_000);

const polls: Sample[] = [];
let purchasesDone = false;

/** What answered a status poll: the CDN cache (HIT) or an API server (MISS, EXPIRED, …). */
async function poll(): Promise<string> {
  try {
    const response = await pollPool.request({ method: 'GET', path: '/api/sale' });
    await response.body.dump();
    const cache = response.headers['x-cache-status'];
    const answeredBy = typeof cache === 'string' ? cache : 'no X-Cache-Status';
    return response.statusCode === 200 ? answeredBy : `${response.statusCode} ${answeredBy}`;
  } catch {
    return 'network error';
  }
}

/** One user's open page: polls the status until the purchases are over. */
async function poller(): Promise<void> {
  // People did not all open the page at the same moment.
  await sleep(Math.random() * POLL_INTERVAL_MS);
  while (!purchasesDone) {
    const sentAt = performance.now();
    const outcome = await poll();
    polls.push({ sentAt: sentAt - startedAt, latencyMs: performance.now() - sentAt, outcome });
    await sleep(POLL_INTERVAL_MS);
  }
}
const polling = Promise.all(Array.from({ length: pollers }, poller));

let next = 0;
async function user(userId: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const sentAt = performance.now();
    const { outcome, orderId, retryAfterMs } = await purchase(userId);
    samples.push({ sentAt: sentAt - startedAt, latencyMs: performance.now() - sentAt, outcome });
    if (orderId) {
      const orders = ordersByUser.get(userId) ?? new Set();
      ordersByUser.set(userId, orders.add(orderId));
    }
    if (retryAfterMs === undefined || attempt >= maxRetries) return;
    await sleep(retryAfterMs);
  }
}

await Promise.all(
  Array.from({ length: connections }, async () => {
    while (next < queue.length) await user(queue[next++]!);
  }),
);
const durationMs = performance.now() - startedAt;
purchasesDone = true;
await polling;
clearInterval(progress);
await Promise.all([pool.close(), pollPool.close()]);

const result: LoadResult = {
  users,
  requests: samples.length,
  connections,
  durationMs,
  outcomes: countOutcomes(samples),
  latencyMs: summarizeLatency(samples),
  timeline: timeline(samples),
  winners: Object.fromEntries(
    [...ordersByUser].map(([userId, orders]) => [userId, [...orders][0]!] as const),
  ),
  conflictingOrders: [...ordersByUser].filter(([, orders]) => orders.size > 1).map(([id]) => id),
  polls:
    pollers > 0
      ? {
          pollers,
          requests: polls.length,
          cache: countOutcomes(polls),
          latencyMs: summarizeLatency(polls),
          timeline: timeline(polls),
        }
      : undefined,
};
console.log(JSON.stringify(result));
