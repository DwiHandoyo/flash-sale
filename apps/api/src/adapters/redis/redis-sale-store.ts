import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import type { Order } from '@flash-sale/shared/order';
import { decodeBuyerRecord, SALE_FIELDS, saleKeys } from '@flash-sale/shared/redis-keys';
import { ReplyError, type Redis, type Result } from 'ioredis';

import { SaleNotInitializedError, SalePausedError } from '../../app/errors';
import type { SaleStore } from '../../app/ports';
import type { ReservationResult } from '../../domain/purchase';
import type { SaleState } from '../../domain/sale';
import { RESERVE_SCRIPT, type ReserveScriptReply } from './reserve-script';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    reserveUnit(
      saleKey: string,
      buyersKey: string,
      userId: string,
      orderId: string,
    ): Result<ReserveScriptReply, Context>;
  }
}

export class RedisSaleStore implements SaleStore {
  private readonly keys: ReturnType<typeof saleKeys>;

  constructor(
    private readonly redis: Redis,
    private readonly saleId: string,
  ) {
    this.keys = saleKeys(saleId);
    // Sent as EVALSHA; ioredis falls back to EVAL (which caches the script) on NOSCRIPT, for
    // example after a Redis restart.
    redis.defineCommand('reserveUnit', { numberOfKeys: 2, lua: RESERVE_SCRIPT });
  }

  async getState(): Promise<SaleState | null> {
    const [startsAt, endsAt, totalStock, remainingStock, paused] = await this.call(() =>
      this.redis.hmget(
        this.keys.sale,
        SALE_FIELDS.startsAt,
        SALE_FIELDS.endsAt,
        SALE_FIELDS.totalStock,
        SALE_FIELDS.remainingStock,
        SALE_FIELDS.paused,
      ),
    );
    if (startsAt == null || endsAt == null || totalStock == null || remainingStock == null) {
      return null;
    }
    return {
      id: this.saleId,
      startsAt: Number(startsAt),
      endsAt: Number(endsAt),
      totalStock: Number(totalStock),
      remainingStock: Number(remainingStock),
      paused: paused != null,
    };
  }

  async reserve(userId: string, orderId: string): Promise<ReservationResult> {
    const [result, record] = await this.call(() =>
      this.redis.reserveUnit(this.keys.sale, this.keys.buyers, userId, orderId),
    );

    switch (result) {
      case 'reserved':
      case 'already_purchased':
        if (record === undefined)
          throw new Error(`Reserve script returned ${result} without an order`);
        return { kind: result, order: decodeBuyerRecord(userId, record) };
      case 'paused':
      case 'not_started':
      case 'ended':
      case 'sold_out':
        return { kind: result };
      case 'not_initialized':
        throw new SaleNotInitializedError();
      default:
        throw new Error(`Unexpected reserve script result: ${String(result)}`);
    }
  }

  async findOrder(userId: string): Promise<Order | null> {
    // One transaction, so the sale flags and the buyer are read at the same moment.
    const replies = await this.call(() =>
      this.redis
        .multi()
        .hmget(this.keys.sale, SALE_FIELDS.startsAt, SALE_FIELDS.paused)
        .hget(this.keys.buyers, userId)
        .exec(),
    );
    const [[, sale], [, record]] = replies as [
      [Error | null, (string | null)[]],
      [Error | null, string | null],
    ];

    if (sale[0] == null) throw new SaleNotInitializedError();
    if (sale[1] != null) throw new SalePausedError();
    return record === null ? null : decodeBuyerRecord(userId, record);
  }

  private async call<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error) {
      // A reply error means Redis answered (e.g. a script bug): a genuine server error.
      // Anything else is a connectivity problem: the outcome is unknown and safe to retry.
      if (error instanceof ReplyError) throw error;
      throw new DependencyUnavailableError('redis', error);
    }
  }
}
