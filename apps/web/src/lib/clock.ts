/** What the app believes about the server's clock: server time = local time + offsetMs. */
export interface ClockEstimate {
  readonly offsetMs: number;
  /** Local time of the sample the estimate came from. */
  readonly measuredAt: number;
}

/** Start over now and then, so a device clock that drifts is corrected too. */
export const CLOCK_ESTIMATE_MAX_AGE_MS = 5 * 60_000;

/**
 * Updates the clock estimate from one status response.
 *
 * When a response arrives, the server's clock reads at least its `serverTime`: the response was
 * made before it arrived, whether fresh or served later from the CDN cache. So `serverTime −
 * receivedAt` is a lower bound of the offset that is always true. A fresh response gives a tight
 * bound; a cached one gives a looser bound, never a wrong one. Keeping the largest bound makes stale
 * answers harmless, and the countdown never jumps backwards. Being a bound, the estimate can trail
 * the server by up to one round trip, so the buy button never unlocks early.
 */
export function updateClockEstimate(
  current: ClockEstimate | undefined,
  serverTime: number,
  receivedAt: number,
): ClockEstimate {
  const sample = { offsetMs: serverTime - receivedAt, measuredAt: receivedAt };
  if (!current || receivedAt - current.measuredAt > CLOCK_ESTIMATE_MAX_AGE_MS) return sample;
  return sample.offsetMs > current.offsetMs ? sample : current;
}
