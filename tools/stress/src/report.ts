import type { LoadResult } from './load-result';
import type { Check } from './verify';

export interface ReportInput {
  readonly fault: string;
  readonly stock: number;
  readonly doubleClickers: number;
  readonly appendfsync: string;
  readonly load: LoadResult;
  readonly checks: readonly Check[];
}

const n = (value: number) => Math.round(value).toLocaleString('en-US');
const ms = (value: number) => `${n(value)} ms`;

export function formatReport({
  fault,
  stock,
  doubleClickers,
  appendfsync,
  load,
  checks,
}: ReportInput): string {
  const seconds = load.durationMs / 1_000;
  const outcomes = Object.entries(load.outcomes).sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(...outcomes.map(([outcome]) => outcome.length));
  const passed = checks.filter((check) => check.passed).length;

  return [
    '',
    'Flash sale stress test',
    `  Fault          ${fault}`,
    `  Users          ${n(load.users)} (${n(doubleClickers)} of them click twice)`,
    `  Stock          ${n(stock)}`,
    `  Connections    ${n(load.connections)}`,
    `  Redis fsync    ${appendfsync}`,
    '',
    `Responses: ${n(load.requests)} requests in ${seconds.toFixed(2)} s = ${n(load.requests / seconds)} requests/s`,
    ...outcomes.map(([outcome, count]) => `  ${outcome.padEnd(width)}  ${n(count).padStart(7)}`),
    `Latency: p50 ${ms(load.latencyMs.p50)} · p95 ${ms(load.latencyMs.p95)} · p99 ${ms(load.latencyMs.p99)} · max ${ms(load.latencyMs.max)}`,
    '',
    'Responses by the second they were sent in',
    ...load.timeline.map(
      ({ second, outcomes: perSecond }) =>
        `  ${String(second).padStart(3)} s  ` +
        Object.entries(perSecond)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([outcome, count]) => `${outcome} ${n(count)}`)
          .join(' · '),
    ),
    '',
    'Checks',
    ...checks.map((check) => `  ${check.passed ? '✓' : '✗'} ${check.name}: ${check.detail}`),
    '',
    passed === checks.length
      ? `PASSED (${passed}/${checks.length} checks)`
      : `FAILED (${checks.length - passed} of ${checks.length} checks)`,
    '',
  ].join('\n');
}
