import type { LatencySummary, TimelineBucket } from './stats';

/** What the load generator reports to run.ts: one JSON line on stdout. */
export interface LoadResult {
  readonly users: number;
  /** Purchase requests sent, including double clicks and retries. */
  readonly requests: number;
  readonly connections: number;
  readonly durationMs: number;
  /** Number of responses per outcome, for example { "201 purchased": 100 }. */
  readonly outcomes: Record<string, number>;
  readonly latencyMs: LatencySummary;
  readonly timeline: TimelineBucket[];
  /** Every user who was told they have an item (201, or 409 already_purchased), with the order ID. */
  readonly winners: Record<string, string>;
  /** Users who were given two different order IDs. Must stay empty. */
  readonly conflictingOrders: string[];
  /** Status polls, with --pollers: how the CDN cache answered them (its X-Cache-Status). */
  readonly polls?: {
    readonly pollers: number;
    readonly requests: number;
    readonly cache: Record<string, number>;
    readonly latencyMs: LatencySummary;
    readonly timeline: TimelineBucket[];
  };
}
