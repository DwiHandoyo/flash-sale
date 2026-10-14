export class SaleNotInitializedError extends Error {
  override name = 'SaleNotInitializedError';

  constructor() {
    super('The sale has not been initialised yet.');
  }
}

/** The recovery job paused the sale; Redis may not have its buyers back yet. */
export class SalePausedError extends Error {
  override name = 'SalePausedError';

  constructor() {
    super('The sale is paused for recovery.');
  }
}
