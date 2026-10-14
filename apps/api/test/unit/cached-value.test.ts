import { describe, expect, it, vi } from 'vitest';

import { CachedValue } from '../../src/app/cached-value';

describe('CachedValue', () => {
  it('reuses the value within the TTL and reloads after it', async () => {
    let now = 0;
    let version = 0;
    const cache = new CachedValue(
      () => Promise.resolve(++version),
      500,
      () => now,
    );

    expect(await cache.get()).toBe(1);
    now = 499;
    expect(await cache.get()).toBe(1);
    now = 500;
    expect(await cache.get()).toBe(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const load = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('state'), 10)),
    );
    const cache = new CachedValue(load, 0);

    const values = await Promise.all(Array.from({ length: 100 }, () => cache.get()));

    expect(new Set(values)).toEqual(new Set(['state']));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce('state');
    const cache = new CachedValue(load, 1_000);

    await expect(cache.get()).rejects.toThrow('redis down');
    await expect(cache.get()).resolves.toBe('state');
  });
});
