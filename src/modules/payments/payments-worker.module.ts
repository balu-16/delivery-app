import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_CONCERN_QUEUES } from '../../platform/contracts/runtime.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import { PaymentPollerService, RefundRecoveryService } from './infrastructure/payment-recovery.js';
import { NightlyReconciliationService } from './infrastructure/reconciliation.js';
import { PaymentsModule, WEBHOOK_JOB } from './payments.module.js';
import {
  PAYMENT_WEBHOOKS,
  PAYMENT_ORDERS,
  type PaymentOrderOperations,
  type PaymentWebhookIngest,
  type WebhookInboxQuery,
} from './contracts/payments.js';

/**
 * Worker-only activation of webhook processing: the concern handler runs after
 * the HTTP acknowledgement and the recovery scan re-enqueues durable inbox
 * rows whose Redis jobs were lost. Ingest stays writable without Redis
 * because the inbox row is the durable obligation, not the queue entry.
 */
@Injectable()
export class PaymentWebhookWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private lastReconciliation = 0;
  private active?: Promise<void>;
  constructor(
    @Inject(PAYMENT_WEBHOOKS) private readonly webhooks: PaymentWebhookIngest & WebhookInboxQuery,
    @Inject(PLATFORM_CONCERN_QUEUES) private readonly queues: ConcernQueues,
    private readonly poller: PaymentPollerService,
    private readonly refunds: RefundRecoveryService,
    private readonly reconciliation: NightlyReconciliationService,
    @Inject(PAYMENT_ORDERS) private readonly paymentOrders: PaymentOrderOperations,
  ) {}
  onApplicationBootstrap(): void {
    this.queues.register('payments', WEBHOOK_JOB, async (data) => {
      const inboxId = (data as { inboxId?: string }).inboxId;
      if (typeof inboxId !== 'string' || !inboxId) throw new Error('INVALID_WEBHOOK_JOB');
      await this.webhooks.processOne(inboxId);
    });
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.recover()
        .catch(() => undefined)
        .finally(() => {
          this.active = undefined;
        });
    }, 5000);
    this.timer.unref();
  }
  private async recover(): Promise<void> {
    await this.paymentOrders.recoverPendingBatch(100);
    await this.poller.pollNearExpiry(100, 300);
    await this.refunds.recoverBatch(100);
    if (Date.now() - this.lastReconciliation >= 86400_000) {
      await this.reconciliation.run(100);
      this.lastReconciliation = Date.now();
    }
    const due = await this.webhooks.dueEvents(100);
    for (const event of due)
      await this.queues
        .enqueue('payments', WEBHOOK_JOB, { inboxId: event.inboxId }, event.inboxId)
        .catch(() => undefined);
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

/** Wired by the composition root only for APP_ROLE all|worker. */
@Module({
  imports: [PaymentsModule],
  providers: [PaymentWebhookWorker],
})
export class PaymentsWorkerModule {}
