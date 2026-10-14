import type { Order } from '@flash-sale/shared/order';

import type { SaleStatusView } from '../../app/use-cases';
import type { PurchaseOutcome } from '../../domain/purchase';

/** The response contract from docs/05-api.md. */

const toIso = (epochMs: number) => new Date(epochMs).toISOString();

export function toOrderDto(order: Order) {
  return { orderId: order.orderId, userId: order.userId, purchasedAt: toIso(order.purchasedAt) };
}

export function toSaleStatusDto(view: SaleStatusView) {
  return {
    saleId: view.id,
    status: view.status,
    startsAt: toIso(view.startsAt),
    endsAt: toIso(view.endsAt),
    totalStock: view.totalStock,
    remainingStock: view.remainingStock,
    serverTime: toIso(view.serverTime),
  };
}

/** Rejections are 409: the request is valid but conflicts with the sale's current state. */
export function toPurchaseResponse(outcome: PurchaseOutcome) {
  switch (outcome.kind) {
    case 'purchased':
      return {
        statusCode: 201,
        body: {
          code: 'purchased',
          message: 'You secured the item!',
          order: toOrderDto(outcome.order),
        },
      };
    case 'already_purchased':
      return {
        statusCode: 409,
        body: {
          code: 'already_purchased',
          message: 'You already have one (limit one per customer).',
          order: toOrderDto(outcome.order),
        },
      };
    case 'sold_out':
      return {
        statusCode: 409,
        body: { code: 'sold_out', message: 'Sorry, the item is sold out.' },
      };
    case 'not_started':
      return {
        statusCode: 409,
        body: { code: 'sale_not_started', message: 'The sale has not started yet.' },
      };
    case 'ended':
      return { statusCode: 409, body: { code: 'sale_ended', message: 'The sale has ended.' } };
    case 'paused':
      return { statusCode: 503, body: SALE_PAUSED };
  }
}

export const SALE_PAUSED = {
  code: 'sale_paused',
  message: 'The sale is paused for a moment. Please try again shortly.',
} as const;
