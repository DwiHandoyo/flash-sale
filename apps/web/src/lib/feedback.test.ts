import { describe, expect, it } from 'vitest';

import type { PurchaseCode } from '../api';
import { feedbackForLookup, feedbackForPurchase } from './feedback';

const order = { orderId: 'o-1', userId: 'alice', purchasedAt: '2026-01-01T10:00:01.000Z' };

describe('feedbackForPurchase', () => {
  it.each<[PurchaseCode, string, string]>([
    ['purchased', 'success', 'You got it!'],
    ['already_purchased', 'info', 'You already have one'],
    ['sold_out', 'warning', 'Sold out'],
    ['sale_not_started', 'warning', 'Not open yet'],
    ['sale_ended', 'warning', 'The sale has ended'],
    ['invalid_user_id', 'error', 'Please check your username or email'],
  ])('describes %s', (code, tone, title) => {
    expect(feedbackForPurchase({ code, message: 'server message', order })).toMatchObject({
      tone,
      title,
    });
  });

  it('shows the order for successful and repeated purchases', () => {
    expect(feedbackForPurchase({ code: 'purchased', message: '', order }).order).toEqual(order);
    expect(feedbackForPurchase({ code: 'already_purchased', message: '', order }).order).toEqual(
      order,
    );
  });
});

describe('feedbackForLookup', () => {
  it('confirms an existing purchase', () => {
    expect(feedbackForLookup({ userId: 'alice', purchased: true, order })).toMatchObject({
      tone: 'success',
      order,
    });
  });

  it('explains when there is no purchase', () => {
    expect(feedbackForLookup({ userId: 'bob', purchased: false })).toMatchObject({
      tone: 'info',
      title: 'No purchase yet',
    });
  });
});
