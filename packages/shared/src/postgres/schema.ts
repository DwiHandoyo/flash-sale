import type pg from 'pg';

import { withTransaction } from './pool';

const MIGRATION_LOCK_ID = 7_270_001;

/** The schema from docs/04-data-model.md. Idempotent, so it is safe to run on every start-up. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sales (
  id          TEXT PRIMARY KEY,
  total_stock INTEGER NOT NULL CHECK (total_stock >= 0),
  sold_count  INTEGER NOT NULL DEFAULT 0,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_window_valid CHECK (ends_at > starts_at),
  -- The last guard against overselling: an order that would exceed the stock is refused.
  CONSTRAINT sales_not_oversold CHECK (sold_count <= total_stock)
);

CREATE TABLE IF NOT EXISTS orders (
  order_id     UUID PRIMARY KEY,
  sale_id      TEXT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- "One item per user", enforced a second time, independently of Redis.
  CONSTRAINT orders_one_per_user UNIQUE (sale_id, user_id)
);
`;

/**
 * The advisory lock serialises concurrent start-ups; CREATE ... IF NOT EXISTS alone can race. It
 * is transaction-scoped, so it also works behind PgBouncer or RDS Proxy in transaction pooling
 * mode, where a session-level lock and its unlock could land on different server connections.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
  });
}
