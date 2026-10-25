import { describe, expect, it } from 'vitest';

import { CLOCK_ESTIMATE_MAX_AGE_MS, updateClockEstimate } from './clock';

describe('updateClockEstimate', () => {
  it('takes the first sample as the estimate', () => {
    expect(updateClockEstimate(undefined, 10_500, 10_000)).toEqual({
      offsetMs: 500,
      measuredAt: 10_000,
    });
  });

  it('ignores a stale answer from the CDN cache, so the countdown never jumps back', () => {
    const fresh = updateClockEstimate(undefined, 10_500, 10_000);
    // Served from the cache 4 s later: its serverTime is 4 s old.
    expect(updateClockEstimate(fresh, 10_500, 14_000)).toBe(fresh);
  });

  it('adopts a better sample', () => {
    const slow = updateClockEstimate(undefined, 10_300, 10_000);
    expect(updateClockEstimate(slow, 12_450, 12_000)).toEqual({
      offsetMs: 450,
      measuredAt: 12_000,
    });
  });

  it('starts over after a while, so a drifting device clock is corrected', () => {
    const old = updateClockEstimate(undefined, 10_500, 10_000);
    const later = 10_000 + CLOCK_ESTIMATE_MAX_AGE_MS + 1;
    expect(updateClockEstimate(old, later + 200, later)).toEqual({
      offsetMs: 200,
      measuredAt: later,
    });
  });
});
