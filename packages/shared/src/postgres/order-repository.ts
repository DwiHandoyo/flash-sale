import type { Order } from '../order';
import { classifyPgError } from './errors';
import type { Queryable } from './pool';

interface OrderRow {
  order_id: string;
  user_id: string;
  purchased_at: Date;
}

export class OrderRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Saves orders and returns how many were new. Idempotent, because RabbitMQ delivers at least
   * once: an order that is already saved (same order ID, or the same user) is skipped.
   *
   * One statement inserts the orders and raises the sale's sold_count by the number inserted, so
   * both happen or neither does. If that would exceed the stock, the oversell guard rejects it.
   *
   * @throws OrderRejectedError when PostgreSQL refuses the data (retrying cannot help)
   * @throws DependencyUnavailableError when PostgreSQL cannot be reached
   */
  async saveOrders(saleId: string, orders: readonly Order[]): Promise<number> {
    if (orders.length === 0) return 0;

    try {
      const result = await this.db.query<{ inserted: number }>(
        `WITH inserted AS (
           INSERT INTO orders (order_id, sale_id, user_id, purchased_at)
           SELECT o.order_id, $1, o.user_id, o.purchased_at
           FROM UNNEST($2::uuid[], $3::text[], $4::timestamptz[]) AS o (order_id, user_id, purchased_at)
           ON CONFLICT DO NOTHING
           RETURNING 1
         )
         UPDATE sales
         SET sold_count = sold_count + (SELECT count(*) FROM inserted)
         WHERE id = $1
         RETURNING (SELECT count(*) FROM inserted)::int AS inserted`,
        [
          saleId,
          orders.map((order) => order.orderId),
          orders.map((order) => order.userId),
          orders.map((order) => new Date(order.purchasedAt).toISOString()),
        ],
      );
      return result.rows[0]?.inserted ?? 0;
    } catch (error) {
      throw classifyPgError(error);
    }
  }

  async listBySale(saleId: string): Promise<Order[]> {
    const { rows } = await this.db.query<OrderRow>(
      'SELECT order_id, user_id, purchased_at FROM orders WHERE sale_id = $1 ORDER BY purchased_at',
      [saleId],
    );
    return rows.map((row) => ({
      orderId: row.order_id,
      userId: row.user_id,
      purchasedAt: row.purchased_at.getTime(),
    }));
  }

  async countBySale(saleId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM orders WHERE sale_id = $1',
      [saleId],
    );
    return rows[0]?.count ?? 0;
  }

  async deleteBySale(saleId: string): Promise<void> {
    await this.db.query('DELETE FROM orders WHERE sale_id = $1', [saleId]);
  }
}
