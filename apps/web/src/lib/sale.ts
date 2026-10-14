import type { Sale, SaleStatus } from '../api';

/** Same rule as the server, evaluated locally so the UI flips the moment a countdown ends. */
export function statusAt(sale: Sale, now: number): SaleStatus {
  if (now < Date.parse(sale.startsAt)) return 'upcoming';
  if (now >= Date.parse(sale.endsAt)) return 'ended';
  return sale.remainingStock > 0 ? 'active' : 'sold_out';
}

/** 3_725_000 → "01:02:05"; durations of a day or more get a "2d " prefix. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const clock = [
    Math.floor((totalSeconds % 86_400) / 3_600),
    Math.floor((totalSeconds % 3_600) / 60),
    totalSeconds % 60,
  ]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  return days > 0 ? `${days}d ${clock}` : clock;
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function formatDateTime(value: string | number): string {
  return dateTimeFormat.format(new Date(value));
}
