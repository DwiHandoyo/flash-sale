export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended' | 'paused';

export interface Sale {
  saleId: string;
  status: SaleStatus;
  startsAt: string;
  endsAt: string;
  totalStock: number;
  remainingStock: number;
  serverTime: string;
}

export interface Order {
  orderId: string;
  userId: string;
  purchasedAt: string;
}

export type PurchaseCode =
  | 'purchased'
  | 'already_purchased'
  | 'sold_out'
  | 'sale_not_started'
  | 'sale_ended'
  | 'sale_paused'
  | 'invalid_user_id'
  | 'bad_request';

export interface PurchaseResponse {
  code: PurchaseCode;
  message: string;
  order?: Order;
}

export interface PurchaseLookup {
  userId: string;
  purchased: boolean;
  order?: Order;
}

/** No definitive answer (network failure or 5xx), so the outcome of the request is unknown. */
export class ServiceUnavailableError extends Error {}

/** The sale is paused for a moment (recovery). Nothing happened; try again shortly. */
export class SalePausedError extends Error {}

export async function fetchSale(signal?: AbortSignal): Promise<Sale> {
  const response = await send('/api/sale', { signal, cache: 'no-cache' });
  if (!response.ok)
    throw new ServiceUnavailableError(`Sale status unavailable (${response.status})`);
  return (await response.json()) as Sale;
}

/**
 * Resolves with the business outcome (201, 409, 400, or 503 sale_paused). Throws when the outcome
 * is unknown: a network failure or any other 5xx, after which the purchase may or may not exist.
 */
export async function attemptPurchase(userId: string): Promise<PurchaseResponse> {
  const response = await send('/api/purchases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = (await readJson(response)) as PurchaseResponse | null;
  if (response.status >= 500 && body?.code !== 'sale_paused') {
    throw new ServiceUnavailableError(`Purchase failed (${response.status})`);
  }
  if (!body) throw new ServiceUnavailableError(`Unreadable response (${response.status})`);
  return body;
}

export async function lookupPurchase(userId: string): Promise<PurchaseLookup> {
  const response = await send(`/api/purchases/${encodeURIComponent(userId)}`);
  const body = (await readJson(response)) as
    (PurchaseLookup & { code?: string; message?: string }) | null;
  if (body?.code === 'sale_paused') throw new SalePausedError(body.message);
  if (response.status >= 500 || !body) {
    throw new ServiceUnavailableError(`Lookup failed (${response.status})`);
  }
  if (!response.ok) throw new Error(body.message ?? `Lookup failed (${response.status})`);
  return body;
}

function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ServiceUnavailableError('Network error', { cause: error });
  }
}
