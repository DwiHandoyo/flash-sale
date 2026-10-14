import type { Order, PurchaseLookup, PurchaseResponse } from '../api';

export type Tone = 'success' | 'info' | 'warning' | 'error';

export interface Feedback {
  tone: Tone;
  title: string;
  detail?: string;
  order?: Order;
}

export function feedbackForPurchase(response: PurchaseResponse): Feedback {
  switch (response.code) {
    case 'purchased':
      return {
        tone: 'success',
        title: 'You got it!',
        detail: 'Your item is reserved.',
        order: response.order,
      };
    case 'already_purchased':
      return {
        tone: 'info',
        title: 'You already have one',
        detail: 'It is limited to one per customer, and your order is safe.',
        order: response.order,
      };
    case 'sold_out':
      return {
        tone: 'warning',
        title: 'Sold out',
        detail: 'Every unit has been claimed. Better luck next drop!',
      };
    case 'sale_not_started':
      return {
        tone: 'warning',
        title: 'Not open yet',
        detail: 'The sale has not started. Hang tight!',
      };
    case 'sale_ended':
      return { tone: 'warning', title: 'The sale has ended' };
    case 'sale_paused':
      return SALE_PAUSED;
    default:
      return {
        tone: 'error',
        title: 'Please check your username or email',
        detail: response.message,
      };
  }
}

export function feedbackForLookup(lookup: PurchaseLookup): Feedback {
  return lookup.purchased
    ? { tone: 'success', title: 'You have secured an item', order: lookup.order }
    : {
        tone: 'info',
        title: 'No purchase yet',
        detail: `"${lookup.userId}" has not bought the item.`,
      };
}

export const SALE_PAUSED: Feedback = {
  tone: 'warning',
  title: 'Paused for a moment',
  detail: 'We are double-checking the stock. Please try again in a few seconds.',
};

export const UNCONFIRMED_PURCHASE: Feedback = {
  tone: 'error',
  title: 'We could not confirm your purchase',
  detail:
    'The sale is busy or unreachable. Please try again: retrying is safe, you can never end up with two.',
};
