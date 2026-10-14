import { describe, expect, it } from 'vitest';

import { saleStatusAt, type SaleState } from '../../src/domain/sale';
import { InvalidUserIdError, normalizeUserId, USER_ID_MAX_LENGTH } from '../../src/domain/user-id';

describe('saleStatusAt', () => {
  const sale: SaleState = {
    id: 'drop',
    totalStock: 10,
    remainingStock: 10,
    startsAt: 1_000,
    endsAt: 2_000,
    paused: false,
  };

  it.each([
    { when: 'before the start', now: 999, changes: {}, expected: 'upcoming' },
    { when: 'exactly at the start (inclusive)', now: 1_000, changes: {}, expected: 'active' },
    { when: 'with one unit left', now: 1_500, changes: { remainingStock: 1 }, expected: 'active' },
    { when: 'without stock', now: 1_500, changes: { remainingStock: 0 }, expected: 'sold_out' },
    { when: 'exactly at the end (exclusive)', now: 2_000, changes: {}, expected: 'ended' },
    {
      when: 'after the end, even if sold out',
      now: 2_500,
      changes: { remainingStock: 0 },
      expected: 'ended',
    },
    {
      when: 'while paused, whatever the time',
      now: 1_500,
      changes: { paused: true },
      expected: 'paused',
    },
  ])('is $expected $when', ({ now, changes, expected }) => {
    expect(saleStatusAt({ ...sale, ...changes }, now)).toBe(expected);
  });
});

describe('normalizeUserId', () => {
  it.each([
    ['alice', 'alice'],
    ['  Alice  ', 'alice'],
    ['Alice.Smith+sale@Example.COM', 'alice.smith+sale@example.com'],
    ['José', 'josé'],
    // NFKC folds full-width characters, so look-alike IDs map to the same buyer.
    ['ａｌｉｃｅ', 'alice'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(normalizeUserId(raw)).toBe(expected);
  });

  it.each([
    ['too short', 'ab'],
    ['blank', '    '],
    ['too long', 'a'.repeat(USER_ID_MAX_LENGTH + 1)],
    ['containing spaces', 'alice smith'],
    ['containing markup', '<script>'],
  ])('rejects an ID %s', (_reason, raw) => {
    expect(() => normalizeUserId(raw)).toThrow(InvalidUserIdError);
  });
});
