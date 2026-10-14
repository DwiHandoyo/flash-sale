import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import type { OrderMessage } from '@flash-sale/shared/order';

import type { OrderPublisher } from '../../src/app/ports';

/** Records published orders. Set `available = false` to simulate RabbitMQ not confirming. */
export class FakeOrderPublisher implements OrderPublisher {
  readonly published: OrderMessage[] = [];
  available = true;

  async publish(message: OrderMessage): Promise<void> {
    if (!this.available) throw new DependencyUnavailableError('rabbitmq', new Error('no confirm'));
    this.published.push(message);
  }
}
