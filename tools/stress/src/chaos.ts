/**
 * Faults that `npm run stress -- --chaos <name>` injects while the load runs (docs/09, "Chaos
 * runs"). Each one breaks a component the way it breaks in real life, then heals it the way
 * Docker or an operator would.
 */
import { compose } from './docker';

export interface Chaos {
  readonly description: string;
  /** False when stock may legitimately stay unsold, so the check becomes "no more than the stock". */
  readonly expectSoldOut: boolean;
  readonly inject: () => Promise<unknown>;
  /** How long the fault lasts before `heal` runs. */
  readonly outageMs: number;
  readonly heal: () => Promise<unknown>;
}

const nothing = async () => undefined;

export const CHAOS = {
  'kill-api': {
    description: 'An API server crashes (its Node.js process is killed); Docker restarts it',
    expectSoldOut: true,
    inject: () => compose(['exec', '-T', 'api', 'pkill', '-9', '-f', 'main.mjs']),
    outageMs: 0,
    heal: nothing,
  },
  'kill-worker': {
    description: 'A worker crashes while it holds unacknowledged orders; Docker restarts it',
    expectSoldOut: true,
    inject: () => compose(['exec', '-T', 'worker', 'pkill', '-9', '-f', 'main.mjs']),
    outageMs: 0,
    heal: nothing,
  },
  'stop-postgres': {
    description: 'PostgreSQL is down for 10 seconds',
    expectSoldOut: true,
    inject: () => compose(['stop', 'postgres']),
    outageMs: 10_000,
    heal: () => compose(['up', '-d', '--wait', 'postgres']),
  },
  'restart-redis': {
    description:
      'Redis is killed and started again 2 seconds later; its append-only file restores it',
    expectSoldOut: true,
    inject: () => compose(['kill', 'redis']),
    outageMs: 2_000,
    heal: () => compose(['up', '-d', '--wait', 'redis']),
  },
  'wipe-redis': {
    description: 'Redis loses all its data; the recovery job pauses, rebuilds and resumes the sale',
    // Users who hit the pause may give up, so some stock can stay unsold.
    expectSoldOut: false,
    inject: () => compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']),
    outageMs: 1_000,
    heal: () => compose(['run', '--rm', '--no-deps', '-T', 'jobs', 'recover']),
  },
} satisfies Record<string, Chaos>;

export type ChaosName = keyof typeof CHAOS;

export function isChaosName(name: string): name is ChaosName {
  return Object.hasOwn(CHAOS, name);
}
