/**
 * Redis or RabbitMQ did not answer (disconnected, timed out). The outcome of the operation is
 * unknown: it may or may not have taken effect. Callers answer 503 and rely on idempotent retries.
 */
export class DependencyUnavailableError extends Error {
  override name = 'DependencyUnavailableError';

  constructor(
    readonly dependency: 'redis' | 'rabbitmq' | 'postgres',
    cause: unknown,
  ) {
    super(`${dependency} is unavailable`, { cause });
  }
}
