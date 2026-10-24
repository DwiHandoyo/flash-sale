import { useCallback, useEffect, useState } from 'react';

import { fetchSale, type Sale } from '../api';
import { nextPollDelayMs, statusAt } from '../lib/sale';

export interface SaleSnapshot {
  sale: Sale;
  /** Server clock minus local clock, so countdowns are right even if the device clock is not. */
  clockOffsetMs: number;
}

const POLL_INTERVAL_MS = 2_000;
const MAX_RETRY_DELAY_MS = 15_000;

/**
 * Polls the sale status, backing off while the API is unreachable and pausing in hidden tabs. Polling
 * slows down once the sale is sold out and stops once it has ended.
 */
export function useSaleStatus() {
  const [snapshot, setSnapshot] = useState<SaleSnapshot | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;

    const poll = async () => {
      let nextDelay = nextPollDelayMs('active');
      if (!document.hidden) {
        const sentAt = Date.now();
        try {
          const sale = await fetchSale(controller.signal);
          // Assume the server stamped the response halfway through the round trip.
          const clockOffsetMs = Date.parse(sale.serverTime) - (sentAt + Date.now()) / 2;
          setSnapshot({ sale, clockOffsetMs });
          setConnectionLost(false);
          failures = 0;
          nextDelay = nextPollDelayMs(statusAt(sale, Date.parse(sale.serverTime)));
        } catch {
          if (controller.signal.aborted) return;
          failures += 1;
          setConnectionLost(true);
        }
      }
      // Ended: nothing will change any more. Showing the page again still fetches once.
      if (nextDelay === undefined) return;
      const delay =
        failures > 0 ? Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_RETRY_DELAY_MS) : nextDelay;
      timer = window.setTimeout(() => void poll(), delay);
    };

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refresh]);

  return { snapshot, connectionLost, refresh };
}
