export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended';

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

export async function fetchSale(signal?: AbortSignal): Promise<Sale> {
  const response = await send('/api/sale', { signal, cache: 'no-cache' });
  if (!response.ok)
    throw new ServiceUnavailableError(`Sale status unavailable (${response.status})`);
  return (await response.json()) as Sale;
}

/** Resolves with the business outcome (201/409/400); throws if the outcome is unknown. */
export async function attemptPurchase(userId: string): Promise<PurchaseResponse> {
  const response = await send('/api/purchases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (response.status >= 500)
    throw new ServiceUnavailableError(`Purchase failed (${response.status})`);
  return (await response.json()) as PurchaseResponse;
}

export async function lookupPurchase(userId: string): Promise<PurchaseLookup> {
  const response = await send(`/api/purchases/${encodeURIComponent(userId)}`);
  if (response.status >= 500)
    throw new ServiceUnavailableError(`Lookup failed (${response.status})`);
  const body = (await response.json()) as PurchaseLookup & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `Lookup failed (${response.status})`);
  return body;
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ServiceUnavailableError('Network error', { cause: error });
  }
}
