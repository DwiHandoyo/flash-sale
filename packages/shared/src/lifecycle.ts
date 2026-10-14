import type { Logger } from './logger';

/**
 * Runs `cleanup` once on SIGTERM or SIGINT (for example `docker stop` or a rolling deploy), then
 * exits. If the cleanup hangs, the process exits anyway after `timeoutMs`.
 */
export function exitOnSignal(logger: Logger, cleanup: () => Promise<void>, timeoutMs = 10_000) {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs).unref();

    cleanup().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      },
    );
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
