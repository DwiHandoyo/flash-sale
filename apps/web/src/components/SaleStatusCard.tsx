import type { Sale, SaleStatus } from '../api';
import { formatDateTime, formatDuration } from '../lib/sale';

const BADGES: Record<SaleStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Live now',
  sold_out: 'Sold out',
  ended: 'Ended',
  paused: 'Paused',
};

interface Props {
  sale: Sale;
  status: SaleStatus;
  now: number;
}

export function SaleStatusCard({ sale, status, now }: Props) {
  const percentLeft = sale.totalStock > 0 ? (sale.remainingStock / sale.totalStock) * 100 : 0;

  return (
    <section className="status-card" aria-label="Sale status">
      <div className="status-card__header">
        <span className={`badge badge--${status}`}>{BADGES[status]}</span>
        <span className="countdown">{headline(sale, status, now)}</span>
      </div>

      <div className="stock">
        <p className="stock__numbers">
          <strong>{sale.remainingStock}</strong> of {sale.totalStock} left
        </p>
        <div
          className="meter"
          role="progressbar"
          aria-label="Units left"
          aria-valuemin={0}
          aria-valuemax={sale.totalStock}
          aria-valuenow={sale.remainingStock}
        >
          <div className="meter__fill" style={{ width: `${percentLeft}%` }} />
        </div>
      </div>

      <dl className="window">
        <div>
          <dt>Opens</dt>
          <dd>{formatDateTime(sale.startsAt)}</dd>
        </div>
        <div>
          <dt>Closes</dt>
          <dd>{formatDateTime(sale.endsAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

function headline(sale: Sale, status: SaleStatus, now: number): string {
  switch (status) {
    case 'upcoming':
      return `Starts in ${formatDuration(Date.parse(sale.startsAt) - now)}`;
    case 'active':
      return `Ends in ${formatDuration(Date.parse(sale.endsAt) - now)}`;
    case 'sold_out':
      return 'Every unit has been claimed';
    case 'ended':
      return 'This sale is over';
    case 'paused':
      return 'Back in a moment';
  }
}
