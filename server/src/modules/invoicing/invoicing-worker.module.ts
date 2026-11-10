import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_QUEUE } from '../../platform/contracts/runtime.js';
import type { DurableQueue } from '../../platform/queue/queue.js';
import { InvoicingModule } from './invoicing.module.js';
import { INVOICING, type InvoicingOperations } from './contracts/invoicing.js';
import { InvoicingEventConsumer } from './infrastructure/invoice-consumer.js';

/**
 * Worker-only invoicing effects: the `invoicing` outbox consumer issues
 * numbered invoices strictly from ORDER_DELIVERED events, and the rendering
 * sweep retries PENDING/FAILED documents with the SAME number (ADD-14).
 * HTTP roles never register consumers or schedulers.
 */
@Injectable()
export class InvoicingEffectsWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(
    private readonly consumer: InvoicingEventConsumer,
    @Inject(INVOICING) private readonly issuer: InvoicingOperations,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
  ) {}
  onApplicationBootstrap(): void {
    this.queue.registerHandler(InvoicingEventConsumer.CONSUMER, (tx, event) =>
      this.consumer.handle(tx, event),
    );
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.issuer
        .renderDue(50)
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 60000);
    this.timer.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

/** Wired by the composition root only for APP_ROLE all|worker. */
@Module({
  imports: [InvoicingModule],
  providers: [InvoicingEffectsWorker],
})
export class InvoicingWorkerModule {}
