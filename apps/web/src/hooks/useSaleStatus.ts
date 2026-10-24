import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchSale, type Sale } from '../api';
import { updateClockEstimate, type ClockEstimate } from '../lib/clock';
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
 * slows down once the sale is sold out and stops once it has ended. The clock offset only moves
 * when a response proves a better one (see updateClockEstimate), so cached answers cannot make the
 * countdown jump.
 */
export function useSaleStatus() {
  const [snapshot, setSnapshot] = useState<SaleSnapshot | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [generation, setGeneration] = useState(0);
  // Kept across refreshes: a purchase refreshes the status, and must not reset the clock.
  const clock = useRef<ClockEstimate | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;

    const poll = async () => {
      let nextDelay = nextPollDelayMs('active');
      if (!document.hidden) {
        try {
          const sale = await fetchSale(controller.signal);
          clock.current = updateClockEstimate(
            clock.current,
            Date.parse(sale.serverTime),
            Date.now(),
          );
          setSnapshot({ sale, clockOffsetMs: clock.current.offsetMs });
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
      if (document.hidden) return;
      // The device may have slept; measure the clock again from scratch.
      clock.current = undefined;
      refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refresh]);

  return { snapshot, connectionLost, refresh };
}
