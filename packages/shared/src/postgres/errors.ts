import { DependencyUnavailableError } from '../errors';

/**
 * PostgreSQL refused the data itself: a constraint (for example the oversell guard, or a sale
 * that does not exist) or invalid data. Retrying cannot help, unlike a connection problem.
 */
export class OrderRejectedError extends Error {
  override name = 'OrderRejectedError';

  constructor(cause: unknown) {
    super('PostgreSQL rejected the order', { cause });
  }
}

/**
 * Sorts a PostgreSQL error by what the caller should do about it. SQLSTATE classes 22 (data
 * exception) and 23 (integrity constraint violation) are about the data and will fail again.
 * Everything else (connection refused, shutdown, timeouts) is treated as temporary.
 */
export function classifyPgError(error: unknown): Error {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))) {
    return new OrderRejectedError(error);
  }
  return new DependencyUnavailableError('postgres', error);
}
