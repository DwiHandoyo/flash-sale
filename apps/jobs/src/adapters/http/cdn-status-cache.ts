import type { Logger } from '@flash-sale/shared/logger';

import type { StatusCache } from '../../app/ports';

export interface CdnStatusCacheOptions {
  /** GET /api/sale behind the CDN, for example http://web:8080/api/sale */
  readonly url: string;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Longer than the API servers' own status cache (STATE_CACHE_TTL_MS, 0.5 s). Refreshing sooner
 * could fetch the old state from an API server and store it at the CDN for up to 30 s.
 */
const API_CACHE_EXPIRY_MS = 1_000;

/**
 * Refreshes the CDN's cached sale status. Locally the CDN is nginx: a request with
 * `X-Cache-Refresh: 1` skips the cached copy and stores the fresh answer in its place
 * (apps/web/nginx.conf). In production this is a CloudFront invalidation instead.
 *
 * Best effort: a failure is only logged, because a stale copy expires by itself within 30 s.
 */
export class CdnStatusCache implements StatusCache {
  constructor(private readonly options: CdnStatusCacheOptions) {}

  async refresh(): Promise<void> {
    const { url, logger, sleep } = this.options;
    await sleep(API_CACHE_EXPIRY_MS);
    try {
      const response = await fetch(url, {
        headers: { 'x-cache-refresh': '1' },
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`The CDN answered ${response.status}`);
      logger.info({ url }, 'Refreshed the sale status cached at the CDN');
    } catch (error) {
      logger.warn(
        { err: error, url },
        'Could not refresh the sale status cached at the CDN; it expires by itself within 30 s',
      );
    }
  }
}
