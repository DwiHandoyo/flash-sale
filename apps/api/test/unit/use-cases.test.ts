import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import { describe, expect, it, vi } from 'vitest';

import { CachedValue } from '../../src/app/cached-value';
import { SaleNotInitializedError, SalePausedError } from '../../src/app/errors';
import { createUseCases } from '../../src/app/use-cases';
import { InvalidUserIdError } from '../../src/domain/user-id';
import { FakeOrderPublisher } from '../fakes/fake-order-publisher';
import { InMemorySaleStore } from '../fakes/in-memory-sale-store';

const START = Date.parse('2026-01-01T10:00:00.000Z');
const sale = { id: 'drop', totalStock: 2, startsAt: START, endsAt: START + 3_600_000 };

function setup({
  now = START + 1_000,
  stateCacheTtlMs = 0,
  paused = false,
  initialised = true,
} = {}) {
  let time = now;
  const clock = () => time;
  const store = new InMemorySaleStore(initialised ? sale : null, paused, clock);
  const publisher = new FakeOrderPublisher();
  let orders = 0;
  const useCases = createUseCases({
    saleId: 'drop',
    saleStore: store,
    publisher,
    saleState: new CachedValue(() => store.getState(), stateCacheTtlMs, clock),
    clock,
    newOrderId: () => `order-${++orders}`,
  });
  const spies = { getState: vi.spyOn(store, 'getState'), reserve: vi.spyOn(store, 'reserve') };
  return { useCases, store, publisher, spies, setTime: (value: number) => (time = value) };
}

describe('getSaleStatus', () => {
  it('combines the stored state with the current time', async () => {
    const { useCases } = setup();

    await expect(useCases.getSaleStatus()).resolves.toEqual({
      ...sale,
      remainingStock: 2,
      paused: false,
      status: 'active',
      serverTime: START + 1_000,
    });
  });

  it('serves a burst of polls from one cached snapshot', async () => {
    const { useCases, spies, setTime } = setup({ stateCacheTtlMs: 500 });

    await Promise.all(Array.from({ length: 50 }, () => useCases.getSaleStatus()));
    expect(spies.getState).toHaveBeenCalledTimes(1);

    setTime(START + 1_500);
    await useCases.getSaleStatus();
    expect(spies.getState).toHaveBeenCalledTimes(2);
  });

  it('fails when the sale has not been initialised', async () => {
    const { useCases } = setup({ initialised: false });

    await expect(useCases.getSaleStatus()).rejects.toThrow(SaleNotInitializedError);
  });
});

describe('purchase', () => {
  it('reserves, publishes the order and only then reports a purchase', async () => {
    const { useCases, publisher } = setup();

    const outcome = await useCases.purchase('  Alice ');

    const order = { orderId: 'order-1', userId: 'alice', purchasedAt: START + 1_000 };
    expect(outcome).toEqual({ kind: 'purchased', order });
    expect(publisher.published).toEqual([{ ...order, saleId: 'drop' }]);
  });

  it('returns the original order on a repeat purchase and publishes it again', async () => {
    const { useCases, publisher } = setup();
    const first = await useCases.purchase('alice');

    const second = await useCases.purchase('ALICE');

    expect(second).toEqual({
      kind: 'already_purchased',
      order: (first as { order: unknown }).order,
    });
    expect(publisher.published.map((message) => message.orderId)).toEqual(['order-1', 'order-1']);
  });

  it('publishes nothing for a rejected purchase', async () => {
    const { useCases, publisher } = setup();
    await useCases.purchase('alice');
    await useCases.purchase('bob');

    await expect(useCases.purchase('carol')).resolves.toEqual({ kind: 'sold_out' });
    expect(publisher.published).toHaveLength(2);
  });

  it('answers "not started" without asking the store before the sale opens', async () => {
    const { useCases, spies } = setup({ now: START - 1 });

    await expect(useCases.purchase('alice')).resolves.toEqual({ kind: 'not_started' });
    expect(spies.reserve).not.toHaveBeenCalled();
  });

  it('answers "paused" while the sale is paused for recovery', async () => {
    const { useCases, publisher } = setup({ paused: true });

    await expect(useCases.purchase('alice')).resolves.toEqual({ kind: 'paused' });
    expect(publisher.published).toHaveLength(0);
  });

  it('keeps the reservation when RabbitMQ does not confirm, and completes it on retry', async () => {
    const { useCases, store, publisher } = setup();

    publisher.available = false;
    await expect(useCases.purchase('alice')).rejects.toThrow(DependencyUnavailableError);
    // The unit stays reserved for alice; it is never handed to anyone else.
    await expect(store.findOrder('alice')).resolves.toMatchObject({ orderId: 'order-1' });

    publisher.available = true;
    await expect(useCases.purchase('alice')).resolves.toMatchObject({
      kind: 'already_purchased',
      order: { orderId: 'order-1' },
    });
    expect(publisher.published.map((message) => message.orderId)).toEqual(['order-1']);
  });

  it('rejects an invalid user ID before touching the store', async () => {
    const { useCases, spies } = setup();

    await expect(useCases.purchase('not valid!')).rejects.toThrow(InvalidUserIdError);
    expect(spies.getState).not.toHaveBeenCalled();
    expect(spies.reserve).not.toHaveBeenCalled();
  });
});

describe('getPurchase', () => {
  it('looks the order up by the normalised user ID', async () => {
    const { useCases } = setup();
    await useCases.purchase('alice');

    await expect(useCases.getPurchase('ALICE')).resolves.toMatchObject({
      userId: 'alice',
      order: { orderId: 'order-1' },
    });
    await expect(useCases.getPurchase('bob')).resolves.toEqual({ userId: 'bob', order: null });
  });

  it('refuses to answer while the sale is paused for recovery', async () => {
    const { useCases } = setup({ paused: true });

    await expect(useCases.getPurchase('alice')).rejects.toThrow(SalePausedError);
  });
});
