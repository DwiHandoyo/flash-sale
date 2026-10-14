/** Summaries of what the load generator saw. */

export interface Sample {
  /** When the request was sent, in milliseconds after the burst started. */
  readonly sentAt: number;
  readonly latencyMs: number;
  /** For example "201 purchased", "409 sold_out", "503 service_unavailable" or "network error". */
  readonly outcome: string;
}

export interface LatencySummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface TimelineBucket {
  /** Seconds after the burst started: 0 covers [0 s, 1 s). */
  readonly second: number;
  readonly outcomes: Record<string, number>;
}

/** The nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarizeLatency(samples: readonly Sample[]): LatencySummary {
  const sorted = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

export function countOutcomes(samples: readonly Sample[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { outcome } of samples) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}

/** Outcomes per second, by the time each request was sent: shows what a fault did and when. */
export function timeline(samples: readonly Sample[]): TimelineBucket[] {
  const buckets: TimelineBucket[] = [];
  for (const sample of samples) {
    const second = Math.floor(sample.sentAt / 1_000);
    while (buckets.length <= second) buckets.push({ second: buckets.length, outcomes: {} });
    const { outcomes } = buckets[second]!;
    outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
  }
  return buckets;
}
