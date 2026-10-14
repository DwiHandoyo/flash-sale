import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { RecoveryBlockedError, waitUntilDrained } from '../../src/app/recover';
import { dueReconcileRuns } from '../../src/app/schedule';

describe('waitUntilDrained', () => {
  /** A fake queue whose in-flight count follows a script, with a fake clock. Paused at t=0. */
  function setup(counts: (number | undefined)[], { settleMs = 1_000, timeoutMs = 10_000 } = {}) {
    let now = 0;
    let reads = 0;
    const deps = {
      logger: pino({ level: 'silent' }),
      drain: { settleMs, timeoutMs, pollMs: 500 },
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      queues: {
        ordersInFlight: async () => counts[Math.min(reads++, counts.length - 1)],
        declareTopology: async () => undefined,
        deadLetters: async () => 0,
        purge: async () => undefined,
      },
    };
    return { deps, elapsed: () => now, reads: () => reads };
  }

  it('ignores readings while things settle after the pause, then returns on the first zero', async () => {
    const { deps, elapsed, reads } = setup([0]);

    await waitUntilDrained(deps, 0, async () => false);

    expect(elapsed()).toBe(1_000);
    expect(reads()).toBe(1);
  });

  it('keeps waiting while orders are in flight', async () => {
    const { deps, elapsed } = setup([2, 1, 0]);

    await waitUntilDrained(deps, 0, async () => false);

    expect(elapsed()).toBe(2_000);
  });

  it('treats an unknown count as not drained', async () => {
    const { deps, elapsed } = setup([undefined, 0]);

    await waitUntilDrained(deps, 0, async () => false);

    expect(elapsed()).toBe(1_500);
  });

  it('stops early when every unit is already persisted', async () => {
    const { deps, elapsed } = setup([5]);

    await waitUntilDrained(deps, 0, async () => true);

    expect(elapsed()).toBe(0);
  });

  it('gives up when the queue never drains, for example when no worker runs', async () => {
    const { deps } = setup([3], { timeoutMs: 2_000 });

    await expect(waitUntilDrained(deps, 0, async () => false)).rejects.toThrow(
      RecoveryBlockedError,
    );
  });
});

describe('dueReconcileRuns', () => {
  const sale = { id: 'drop', endsAt: 10_000 };
  const retryDelayMs = 300_000;

  it('has nothing to do before the sale ends', () => {
    expect(dueReconcileRuns(sale, 9_999, new Set(), retryDelayMs)).toEqual([]);
  });

  it('runs at endsAt, and once more after the retry delay', () => {
    expect(dueReconcileRuns(sale, 10_000, new Set(), retryDelayMs)).toEqual(['drop@10000']);
    expect(dueReconcileRuns(sale, 310_000, new Set(['drop@10000']), retryDelayMs)).toEqual([
      'drop@310000',
    ]);
  });

  it('never repeats a run that is done', () => {
    const done = new Set(['drop@10000', 'drop@310000']);

    expect(dueReconcileRuns(sale, 1_000_000, done, retryDelayMs)).toEqual([]);
  });

  it('schedules fresh runs when the sale is reset with a new end time', () => {
    const done = new Set(['drop@10000', 'drop@310000']);

    expect(dueReconcileRuns({ id: 'drop', endsAt: 500_000 }, 500_000, done, retryDelayMs)).toEqual([
      'drop@500000',
    ]);
  });
});
