import { PurchasePanel } from './components/PurchasePanel';
import { SaleStatusCard } from './components/SaleStatusCard';
import { useSaleStatus } from './hooks/useSaleStatus';
import { useServerNow } from './hooks/useServerNow';
import { statusAt } from './lib/sale';

export function App() {
  const { snapshot, connectionLost, refresh } = useSaleStatus();
  const now = useServerNow(snapshot?.clockOffsetMs ?? 0);
  const status = snapshot ? statusAt(snapshot.sale, now) : null;

  return (
    <div className="page">
      <header className="masthead">
        <span className="brand">
          flash<strong>drop</strong>
        </span>
      </header>

      <main className="layout">
        <section className="product" aria-labelledby="product-name">
          <div className="product__visual" aria-hidden="true">
            <span>A1</span>
          </div>
          <p className="eyebrow">Limited edition · One per customer</p>
          <h1 id="product-name">Aurora One</h1>
          <p className="product__copy">
            A numbered run of our signature sneaker, released for one hour only. When they are gone,
            they are gone.
          </p>
        </section>

        <section className="panel" aria-label="Buy">
          {connectionLost && (
            <p className="connection-warning" role="status">
              Live updates paused, reconnecting…
            </p>
          )}
          {snapshot && status ? (
            <SaleStatusCard sale={snapshot.sale} status={status} now={now} />
          ) : (
            <div className="status-card status-card--loading">Loading the sale…</div>
          )}
          <PurchasePanel status={status} onPurchaseSettled={refresh} />
        </section>
      </main>
    </div>
  );
}
