import type { FastifyPluginAsync } from 'fastify';

import type { UseCases } from '../../app/use-cases';
import { saleStatusCacheControl } from './cache-control';
import { toOrderDto, toPurchaseResponse, toSaleStatusDto } from './responses';
import {
  errorResponse,
  purchaseBody,
  purchaseLookupResponse,
  purchaseResponse,
  saleStatusResponse,
  userIdParams,
} from './schemas';

interface UserIdPayload {
  userId: string;
}

export const apiRoutes: FastifyPluginAsync<{ useCases: UseCases }> = async (app, { useCases }) => {
  app.get(
    '/sale',
    { schema: { response: { 200: saleStatusResponse, '5xx': errorResponse } } },
    async (_request, reply) => {
      const view = await useCases.getSaleStatus();
      // Every client polls this endpoint; shared caching lets a CDN absorb most of it.
      void reply.header('cache-control', saleStatusCacheControl(view));
      return toSaleStatusDto(view);
    },
  );

  app.post<{ Body: UserIdPayload }>(
    '/purchases',
    {
      schema: {
        body: purchaseBody,
        response: {
          201: purchaseResponse,
          409: purchaseResponse,
          503: purchaseResponse,
          '4xx': errorResponse,
          '5xx': errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { statusCode, body } = toPurchaseResponse(await useCases.purchase(request.body.userId));
      if (statusCode === 503) void reply.header('retry-after', '2');
      return reply.code(statusCode).send(body);
    },
  );

  app.get<{ Params: UserIdPayload }>(
    '/purchases/:userId',
    {
      schema: {
        params: userIdParams,
        response: { 200: purchaseLookupResponse, '4xx': errorResponse, '5xx': errorResponse },
      },
    },
    async (request) => {
      const { userId, order } = await useCases.getPurchase(request.params.userId);
      return order
        ? { userId, purchased: true, order: toOrderDto(order) }
        : { userId, purchased: false };
    },
  );
};

export const healthRoutes: FastifyPluginAsync<{ isReady: () => Promise<boolean> }> = async (
  app,
  { isReady },
) => {
  /** Liveness: the process is up. Restart the container if this fails. */
  app.get('/health/live', async () => ({ status: 'ok' }));

  /** Readiness: Redis and RabbitMQ are reachable. Take the instance out of rotation if not. */
  app.get('/health/ready', async (_request, reply) => {
    const ready = await isReady().catch(() => false);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable' });
  });
};
