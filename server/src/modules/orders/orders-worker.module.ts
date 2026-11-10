import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_QUEUE } from '../../platform/contracts/runtime.js';
import type { DurableQueue } from '../../platform/queue/queue.js';
import { OrdersModule } from './orders.module.js';
import { OrderService } from './infrastructure/order-service.js';
import { OrderPaymentEventConsumer } from './infrastructure/order-consumer.js';

/**
 * Worker-only order effects: the `orders` outbox consumer applies verified
 * captures/failures to the order aggregate exactly once (processed_events
 * plus the locked state machine), and the payment-window sweeper expires
 * stale PENDING_PAYMENT orders through the shared compensation routine.
 * Reinstatement of a late capture runs INSIDE the consumer transaction.
 * HTTP roles never register consumers or schedulers.
 */
@Injectable()
export class OrderEffectsWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(
    private readonly consumer: OrderPaymentEventConsumer,
    private readonly orders: OrderService,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
  ) {}
  onApplicationBootstrap(): void {
    this.queue.registerHandler(OrderPaymentEventConsumer.CONSUMER, (tx, event) =>
      this.consumer.handle(tx, event),
    );
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.orders
        .expireDue(100)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 30000);
    this.timer.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

/** Wired by the composition root only for APP_ROLE all|worker. */
@Module({
  imports: [OrdersModule],
  providers: [OrderEffectsWorker],
})
export class OrdersWorkerModule {}
