import underPressure from '@fastify/under-pressure';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { UseCases } from '../../app/use-cases';
import { errorHandler } from './error-handler';
import { apiRoutes, healthRoutes } from './routes';

export interface AppOptions {
  readonly useCases: UseCases;
  readonly isReady?: () => Promise<boolean>;
  /** A pino logger; omitted in tests to keep them quiet. */
  readonly logger?: FastifyBaseLogger;
  readonly logRequests?: boolean;
  /** Answer 503 while the event loop lags more than this (0 disables load shedding). */
  readonly maxEventLoopDelayMs?: number;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : {}),
    logController: new LogController({ disableRequestLogging: !options.logRequests }),
    trustProxy: true,
    bodyLimit: 1_024,
    // Outlive the load balancer's idle upstream connections, so it never reuses a closed socket.
    keepAliveTimeout: 72_000,
  });

  if (options.maxEventLoopDelayMs) {
    // Load shedding: when saturated, answer quickly with 503 instead of queueing requests until
    // timeouts and memory pressure take the process down.
    await app.register(underPressure, {
      maxEventLoopDelay: options.maxEventLoopDelayMs,
      pressureHandler: (_request, reply) => {
        void reply.code(503).header('retry-after', '1').send({
          code: 'overloaded',
          message: 'The sale is very busy. Please retry in a moment.',
        });
      },
    });
  }

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ code: 'not_found', message: `${request.method} ${request.url} not found` }),
  );

  await app.register(apiRoutes, { prefix: '/api', useCases: options.useCases });
  await app.register(healthRoutes, { isReady: options.isReady ?? (() => Promise.resolve(true)) });
  return app;
}
