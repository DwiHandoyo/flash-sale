import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/adapters/http/app';
import { CachedValue } from '../../src/app/cached-value';
import type { SaleStore } from '../../src/app/ports';
import { createUseCases } from '../../src/app/use-cases';
import { FakeOrderPublisher } from '../fakes/fake-order-publisher';
import { InMemorySaleStore } from '../fakes/in-memory-sale-store';

const START = Date.parse('2026-01-01T10:00:00.000Z');
const END = Date.parse('2026-01-01T11:00:00.000Z');

describe('HTTP API', () => {
  let now: number;
  let app: FastifyInstance | undefined;
  let publisher: FakeOrderPublisher;

  async function startApp(store: SaleStore, isReady?: () => Promise<boolean>) {
    const useCases = createUseCases({
      saleId: 'drop',
      saleStore: store,
      publisher,
      saleState: new CachedValue(
        () => store.getState(),
        0,
        () => now,
      ),
      clock: () => now,
      newOrderId: () => '0b6f8a52-5d0e-4f43-9f5e-6f1f4e3c9a10',
    });
    app = await buildApp({ useCases, isReady });
    return app;
  }

  function startSale({ totalStock = 2, paused = false } = {}) {
    const store = new InMemorySaleStore(
      { id: 'drop', totalStock, startsAt: START, endsAt: END },
      paused,
      () => now,
    );
    return startApp(store).then(() => store);
  }

  const buy = (userId: unknown) =>
    app!.inject({ method: 'POST', url: '/api/purchases', payload: { userId } });
  const lookup = (userId: string) =>
    app!.inject({ method: 'GET', url: `/api/purchases/${encodeURIComponent(userId)}` });
  const status = () => app!.inject({ method: 'GET', url: '/api/sale' });

  beforeEach(() => {
    now = START + 1_000;
    publisher = new FakeOrderPublisher();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('GET /api/sale', () => {
    it('returns the sale status with one second of shared caching', async () => {
      await startSale();

      const response = await status();

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=1');
      expect(response.json()).toEqual({
        saleId: 'drop',
        status: 'active',
        startsAt: '2026-01-01T10:00:00.000Z',
        endsAt: '2026-01-01T11:00:00.000Z',
        totalStock: 2,
        remainingStock: 2,
        serverTime: '2026-01-01T10:00:01.000Z',
      });
    });

    it('moves from upcoming to active to sold out to ended', async () => {
      await startSale({ totalStock: 1 });
      const statusNow = async () => (await status()).json<{ status: string }>().status;

      now = START - 1;
      expect(await statusNow()).toBe('upcoming');
      now = START;
      expect(await statusNow()).toBe('active');
      await buy('alice');
      expect(await statusNow()).toBe('sold_out');
      now = END;
      expect(await statusNow()).toBe('ended');
    });

    it('reports a paused sale', async () => {
      await startSale({ paused: true });

      expect((await status()).json()).toMatchObject({ status: 'paused' });
    });

    it('answers 503 while the sale is not initialised', async () => {
      await startApp(new InMemorySaleStore(null));

      const response = await status();

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'sale_not_initialized' });
    });
  });

  describe('POST /api/purchases', () => {
    it('answers 201 with the order once it is confirmed', async () => {
      await startSale();

      const response = await buy('alice');

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        code: 'purchased',
        message: expect.any(String),
        order: {
          orderId: '0b6f8a52-5d0e-4f43-9f5e-6f1f4e3c9a10',
          userId: 'alice',
          purchasedAt: '2026-01-01T10:00:01.000Z',
        },
      });
      expect(publisher.published).toHaveLength(1);
    });

    it('answers 409 with the original order when the same user buys again, whatever the casing', async () => {
      await startSale();
      const first = (await buy('alice')).json<{ order: unknown }>();

      const second = await buy('  ALICE ');

      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        code: 'already_purchased',
        message: expect.any(String),
        order: first.order,
      });
    });

    it.each([
      {
        code: 'sold_out',
        arrange: async () => (await buy('alice'), await buy('bob')),
        time: START + 1_000,
      },
      { code: 'sale_not_started', arrange: async () => undefined, time: START - 1 },
      { code: 'sale_ended', arrange: async () => undefined, time: END },
    ])('answers 409 $code', async ({ code, arrange, time }) => {
      await startSale();
      await arrange();
      now = time;

      const response = await buy('carol');

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code, message: expect.any(String) });
    });

    it('answers 503 sale_paused while the sale is paused', async () => {
      await startSale({ paused: true });

      const response = await buy('alice');

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('2');
      expect(response.json()).toMatchObject({ code: 'sale_paused' });
    });

    it('answers 503 service_unavailable when RabbitMQ does not confirm', async () => {
      await startSale();
      publisher.available = false;

      const response = await buy('alice');

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ code: 'service_unavailable' });
    });

    it('answers 503 service_unavailable when Redis is unreachable', async () => {
      const unreachable = new InMemorySaleStore(null);
      unreachable.getState = () =>
        Promise.reject(new DependencyUnavailableError('redis', new Error('ECONNREFUSED')));
      await startApp(unreachable);

      const response = await buy('alice');

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'service_unavailable' });
    });

    it.each([
      ['an invalid user ID', 'not valid!', 'invalid_user_id'],
      ['a missing user ID', undefined, 'bad_request'],
      ['a user ID that is not a string', { id: 1 }, 'bad_request'],
    ])('answers 400 for %s', async (_label, userId, code) => {
      await startSale();

      const response = await buy(userId);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code });
    });

    it('answers 400 for malformed JSON', async () => {
      await startSale();

      const response = await app!.inject({
        method: 'POST',
        url: '/api/purchases',
        headers: { 'content-type': 'application/json' },
        payload: '{"userId":',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'bad_request' });
    });
  });

  describe('GET /api/purchases/:userId', () => {
    it('finds the order by the normalised user ID', async () => {
      await startSale();
      const { order } = (await buy('alice@example.com')).json<{ order: unknown }>();

      const response = await lookup('Alice@Example.com');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ userId: 'alice@example.com', purchased: true, order });
    });

    it('reports when the user has not purchased', async () => {
      await startSale();

      expect((await lookup('bob')).json()).toEqual({ userId: 'bob', purchased: false });
    });

    it('answers 503 sale_paused while the sale is paused', async () => {
      await startSale({ paused: true });

      const response = await lookup('alice');

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'sale_paused' });
    });

    it('answers 400 for an invalid user ID', async () => {
      await startSale();

      expect((await lookup('x')).json()).toMatchObject({ code: 'invalid_user_id' });
    });
  });

  describe('health checks', () => {
    it('reports live and ready', async () => {
      await startSale();

      expect((await app!.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
      expect((await app!.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    });

    it('reports not ready when a dependency is down', async () => {
      await startApp(new InMemorySaleStore(null), () => Promise.reject(new Error('ECONNREFUSED')));

      const response = await app!.inject({ method: 'GET', url: '/health/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'unavailable' });
    });
  });

  it('answers a JSON 404 for unknown routes', async () => {
    await startSale();

    const response = await app!.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });
});
