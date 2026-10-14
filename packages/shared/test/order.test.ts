import { describe, expect, it } from 'vitest';

import {
  decodeOrderMessage,
  encodeOrderMessage,
  InvalidOrderMessageError,
  type OrderMessage,
} from '../src/order';

const message: OrderMessage = {
  orderId: '0b6f8a52-5d0e-4f43-9f5e-6f1f4e3c9a10',
  saleId: 'limited-edition-drop',
  userId: 'alice@example.com',
  purchasedAt: 1_767_225_600_123,
};

describe('order message', () => {
  it('survives an encode/decode round trip unchanged', () => {
    expect(decodeOrderMessage(encodeOrderMessage(message))).toEqual(message);
  });

  it('drops fields that are not part of the contract', () => {
    const withExtra = { ...message, secret: 'should not travel' } as OrderMessage;

    expect(JSON.parse(encodeOrderMessage(withExtra).toString())).not.toHaveProperty('secret');
  });

  it.each([
    ['not JSON', '{"orderId":'],
    ['not an object', '42'],
    ['a missing order id', JSON.stringify({ ...message, orderId: undefined })],
    ['an order id that is not a UUID', JSON.stringify({ ...message, orderId: 'order-1' })],
    ['an empty sale id', JSON.stringify({ ...message, saleId: '' })],
    ['a missing user id', JSON.stringify({ ...message, userId: undefined })],
    ['a timestamp given as text', JSON.stringify({ ...message, purchasedAt: '2026-01-01' })],
    ['a fractional timestamp', JSON.stringify({ ...message, purchasedAt: 1.5 })],
  ])('rejects %s', (_label, content) => {
    expect(() => decodeOrderMessage(Buffer.from(content))).toThrow(InvalidOrderMessageError);
  });
});
