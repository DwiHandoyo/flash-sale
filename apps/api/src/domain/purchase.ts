import type { Order } from '@flash-sale/shared/order';

/** The rules that reject a purchase, in the order the reserve script checks them. */
type Rejection =
  | { readonly kind: 'paused' }
  | { readonly kind: 'not_started' }
  | { readonly kind: 'ended' }
  | { readonly kind: 'sold_out' };

/** What Redis decided. A reservation is not a purchase until RabbitMQ has confirmed the order. */
export type ReservationResult =
  | { readonly kind: 'reserved'; readonly order: Order }
  | { readonly kind: 'already_purchased'; readonly order: Order }
  | Rejection;

/** What the user is told. */
export type PurchaseOutcome =
  | { readonly kind: 'purchased'; readonly order: Order }
  | { readonly kind: 'already_purchased'; readonly order: Order }
  | Rejection;
