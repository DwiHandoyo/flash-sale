/** A flash sale. Times are epoch milliseconds; the sale is open in [startsAt, endsAt). */
export interface SaleDefinition {
  readonly id: string;
  readonly totalStock: number;
  readonly startsAt: number;
  readonly endsAt: number;
}

const SALE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Sale IDs end up inside a Redis Cluster hash tag, so braces and other symbols are not allowed. */
export function isValidSaleId(saleId: string): boolean {
  return SALE_ID_PATTERN.test(saleId);
}
