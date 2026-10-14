import { useEffect, useState } from 'react';

/** The estimated server time, re-rendering every `tickMs` to drive countdowns. */
export function useServerNow(clockOffsetMs: number, tickMs = 250): number {
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setLocalNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);

  return localNow + clockOffsetMs;
}
