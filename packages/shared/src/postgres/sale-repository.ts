import type { SaleDefinition } from '../sale';
import type { Queryable } from './pool';

interface SaleRow {
  id: string;
  total_stock: number;
  sold_count: number;
  starts_at: Date;
  ends_at: Date;
}

export interface StoredSale extends SaleDefinition {
  readonly soldCount: number;
}

export class SaleRepository {
  constructor(private readonly db: Queryable) {}

  /** Creates the sale unless it exists. The stored definition always wins. */
  async ensure(sale: SaleDefinition): Promise<{ sale: StoredSale; created: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO sales (id, total_stock, starts_at, ends_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      toParams(sale),
    );
    const stored = await this.find(sale.id);
    if (!stored) throw new Error(`Sale "${sale.id}" vanished right after it was created`);
    return { sale: stored, created: inserted.rowCount === 1 };
  }

  /** Replaces the definition and restarts the count (used by the reset command). */
  async reset(sale: SaleDefinition): Promise<void> {
    await this.db.query(
      `INSERT INTO sales (id, total_stock, starts_at, ends_at, sold_count)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (id) DO UPDATE
         SET total_stock = EXCLUDED.total_stock,
             starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at,
             sold_count = 0`,
      toParams(sale),
    );
  }

  async find(id: string): Promise<StoredSale | null> {
    const { rows } = await this.db.query<SaleRow>(
      'SELECT id, total_stock, sold_count, starts_at, ends_at FROM sales WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          totalStock: row.total_stock,
          soldCount: row.sold_count,
          startsAt: row.starts_at.getTime(),
          endsAt: row.ends_at.getTime(),
        }
      : null;
  }
}

function toParams(sale: SaleDefinition): unknown[] {
  return [
    sale.id,
    sale.totalStock,
    new Date(sale.startsAt).toISOString(),
    new Date(sale.endsAt).toISOString(),
  ];
}
