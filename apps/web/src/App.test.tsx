import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Sale } from './api';
import { App } from './App';

const HOUR = 3_600_000;

function saleAt(
  offsets: { startsIn: number; endsIn: number },
  overrides: Partial<Sale> = {},
): Sale {
  const now = Date.now();
  return {
    saleId: 'drop',
    status: 'active',
    startsAt: new Date(now + offsets.startsIn).toISOString(),
    endsAt: new Date(now + offsets.endsIn).toISOString(),
    totalStock: 10,
    remainingStock: 7,
    serverTime: new Date(now).toISOString(),
    ...overrides,
  };
}

const liveSale = () => saleAt({ startsIn: -HOUR, endsIn: HOUR });

const order = {
  orderId: '0b6f8a52-5d0e-4f43-9f5e-6f1f4e3c9a10',
  userId: 'alice',
  purchasedAt: new Date().toISOString(),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = () => Response;

function mockApi({
  sale = liveSale(),
  purchase,
  lookup,
}: {
  sale?: Sale;
  purchase?: Handler;
  lookup?: Handler;
}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/sale') return Promise.resolve(json(200, sale));
    if (url === '/api/purchases' && init?.method === 'POST' && purchase) {
      return Promise.resolve().then(purchase);
    }
    if (url.startsWith('/api/purchases/') && lookup) return Promise.resolve().then(lookup);
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function enterUserId(userId: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Your username or email'), userId);
  return user;
}

describe('App', () => {
  it('shows the live sale and confirms a successful purchase', async () => {
    const fetchMock = mockApi({
      purchase: () => json(201, { code: 'purchased', message: 'You secured the item!', order }),
    });
    render(<App />);

    expect(await screen.findByText('Live now')).toBeInTheDocument();
    expect(screen.getByText(/of 10 left/)).toHaveTextContent('7 of 10 left');

    const user = await enterUserId('alice');
    await user.click(screen.getByRole('button', { name: 'Buy now' }));

    expect(await screen.findByText('You got it!')).toBeInTheDocument();
    expect(screen.getByText(order.orderId)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/purchases',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ userId: 'alice' }) }),
    );
  });

  it('tells the buyer when the item is sold out', async () => {
    mockApi({ purchase: () => json(409, { code: 'sold_out', message: 'Sold out' }) });
    render(<App />);

    const user = await enterUserId('bob');
    await user.click(await screen.findByRole('button', { name: 'Buy now' }));

    expect(await screen.findByText('Sold out')).toBeInTheDocument();
  });

  it('tells the buyer they already have one', async () => {
    mockApi({
      purchase: () => json(409, { code: 'already_purchased', message: 'Already purchased', order }),
    });
    render(<App />);

    const user = await enterUserId('alice');
    await user.click(await screen.findByRole('button', { name: 'Buy now' }));

    expect(await screen.findByText('You already have one')).toBeInTheDocument();
    expect(screen.getByText(order.orderId)).toBeInTheDocument();
  });

  it('keeps the buy button disabled until the sale opens', async () => {
    mockApi({ sale: saleAt({ startsIn: HOUR, endsIn: 2 * HOUR }, { status: 'upcoming' }) });
    render(<App />);

    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText(/^Starts in/)).toBeInTheDocument();

    await enterUserId('alice');
    expect(screen.getByRole('button', { name: 'Not open yet' })).toBeDisabled();
  });

  it('checks the order status when the purchase response is lost', async () => {
    mockApi({
      purchase: () => {
        throw new TypeError('Failed to fetch');
      },
      lookup: () => json(200, { userId: 'alice', purchased: true, order }),
    });
    render(<App />);

    const user = await enterUserId('alice');
    await user.click(await screen.findByRole('button', { name: 'Buy now' }));

    expect(await screen.findByText('You have secured an item')).toBeInTheDocument();
  });

  it('lets a buyer check their purchase', async () => {
    mockApi({ lookup: () => json(200, { userId: 'bob', purchased: false }) });
    render(<App />);

    const user = await enterUserId('bob');
    await user.click(screen.getByRole('button', { name: 'Check my purchase' }));

    expect(await screen.findByText('No purchase yet')).toBeInTheDocument();
  });
});
