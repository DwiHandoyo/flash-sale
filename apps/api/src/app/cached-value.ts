/**
 * Caches the result of an async loader for `ttlMs`. Concurrent callers share one in-flight load
 * (single flight), so a burst of requests becomes one backend call instead of thousands.
 */
export class CachedValue<T> {
  private cached: { value: T; expiresAt: number } | undefined;
  private inflight: Promise<T> | undefined;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(): Promise<T> {
    if (this.cached && this.clock() < this.cached.expiresAt) return this.cached.value;

    this.inflight ??= this.load()
      .then((value) => {
        this.cached = { value, expiresAt: this.clock() + this.ttlMs };
        return value;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
