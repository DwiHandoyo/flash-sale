import { describe, expect, it } from 'vitest';

import { decodeBuyerRecord, encodeBuyerRecord, saleKeys } from '../src/redis-keys';

describe('saleKeys', () => {
  it('puts every key of a sale in the same Redis Cluster hash tag', () => {
    const keys = saleKeys('drop-1');

    expect(keys).toEqual({
      sale: 'flash-sale:{drop-1}:sale',
      buyers: 'flash-sale:{drop-1}:buyers',
    });
    for (const key of Object.values(keys)) expect(key).toContain('{drop-1}');
  });
});

describe('buyer record', () => {
  it('round-trips an order', () => {
    const order = { orderId: 'o-1', userId: 'alice', purchasedAt: 1_767_225_600_123 };

    expect(decodeBuyerRecord('alice', encodeBuyerRecord(order))).toEqual(order);
  });

  it('reads the JSON written by the Lua script, whatever the key order', () => {
    // cjson in Redis does not guarantee key order.
    const record = '{"purchasedAt":1767225600123,"orderId":"o-1"}';

    expect(decodeBuyerRecord('alice', record)).toEqual({
      orderId: 'o-1',
      userId: 'alice',
      purchasedAt: 1_767_225_600_123,
    });
  });
});
