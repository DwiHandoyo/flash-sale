import type { Order } from '@flash-sale/shared/order';
import {
  decodeBuyerRecord,
  encodeBuyerRecord,
  SALE_FIELDS,
  saleKeys,
} from '@flash-sale/shared/redis-keys';
import type { SaleDefinition } from '@flash-sale/shared/sale';
import type { ChainableCommander, Redis } from 'ioredis';

import type { SaleStateStore, SyncReport } from '../../app/ports';

const HSET_CHUNK_SIZE = 1_000;
const MAX_SYNC_ATTEMPTS = 5;

export class RedisSaleStateStore implements SaleStateStore {
  private readonly keys: ReturnType<typeof saleKeys>;

  constructor(
    private readonly redis: Redis,
    saleId: string,
  ) {
    this.keys = saleKeys(saleId);
  }

  async getState() {
    const [startsAt, remainingStock, paused] = await this.redis.hmget(
      this.keys.sale,
      SALE_FIELDS.startsAt,
      SALE_FIELDS.remainingStock,
      SALE_FIELDS.paused,
    );
    if (startsAt == null) return null;
    return { remainingStock: Number(remainingStock), paused: paused != null };
  }

  async listBuyers(): Promise<Order[]> {
    const records = await this.redis.hgetall(this.keys.buyers);
    return Object.entries(records).map(([userId, record]) => decodeBuyerRecord(userId, record));
  }

  async sync(sale: SaleDefinition, persisted: readonly Order[]): Promise<SyncReport> {
    // Optimistic transaction: if a purchase changes these keys meanwhile, EXEC aborts and we retry.
    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      await this.redis.watch(this.keys.sale, this.keys.buyers);
      const known = new Set(await this.redis.hkeys(this.keys.buyers));
      const missing = persisted.filter((order) => !known.has(order.userId));
      const buyers = known.size + missing.length;
      const remainingStock = Math.max(0, sale.totalStock - buyers);

      const transaction = this.redis.multi();
      this.addBuyers(transaction, missing);
      this.writeDefinition(transaction, sale, remainingStock);
      if (await transaction.exec()) return { buyers, restored: missing.length, remainingStock };
    }
    throw new Error('Could not sync the sale: it kept changing while syncing');
  }

  async pause(sale: SaleDefinition): Promise<void> {
    await this.redis
      .multi()
      .hset(this.keys.sale, {
        [SALE_FIELDS.startsAt]: sale.startsAt,
        [SALE_FIELDS.endsAt]: sale.endsAt,
        [SALE_FIELDS.totalStock]: sale.totalStock,
        [SALE_FIELDS.paused]: '1',
      })
      // If Redis lost everything, show "no stock" until the rebuild says otherwise.
      .hsetnx(this.keys.sale, SALE_FIELDS.remainingStock, 0)
      .exec();
  }

  async rebuild(sale: SaleDefinition, orders: readonly Order[]): Promise<void> {
    const transaction = this.redis.multi().del(this.keys.buyers);
    this.addBuyers(transaction, orders);
    this.writeDefinition(transaction, sale, Math.max(0, sale.totalStock - orders.length));
    await transaction.exec();
  }

  async resume(): Promise<void> {
    await this.redis.hdel(this.keys.sale, SALE_FIELDS.paused);
  }

  async reset(sale: SaleDefinition): Promise<void> {
    const transaction = this.redis.multi().del(this.keys.sale, this.keys.buyers);
    this.writeDefinition(transaction, sale, sale.totalStock);
    await transaction.exec();
  }

  private addBuyers(transaction: ChainableCommander, orders: readonly Order[]): void {
    for (let i = 0; i < orders.length; i += HSET_CHUNK_SIZE) {
      const chunk = orders.slice(i, i + HSET_CHUNK_SIZE);
      transaction.hset(
        this.keys.buyers,
        Object.fromEntries(chunk.map((order) => [order.userId, encodeBuyerRecord(order)])),
      );
    }
  }

  private writeDefinition(
    transaction: ChainableCommander,
    sale: SaleDefinition,
    remainingStock: number,
  ): void {
    transaction.hset(this.keys.sale, {
      [SALE_FIELDS.startsAt]: sale.startsAt,
      [SALE_FIELDS.endsAt]: sale.endsAt,
      [SALE_FIELDS.totalStock]: sale.totalStock,
      [SALE_FIELDS.remainingStock]: remainingStock,
    });
  }
}
