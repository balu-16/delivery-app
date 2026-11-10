import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_CONCERN_QUEUES, PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import { FakeGateway } from '../../adapters/payments/fake-gateway.js';
import { RazorpayGateway } from '../../adapters/payments/razorpay.js';
import { ResilientGateway } from '../../adapters/payments/resilient-gateway.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './contracts/gateway.js';
import {
  PAYMENT_FRAUD_SIGNALS,
  PAYMENT_ORDERS,
  PAYMENT_REFUNDS,
  PAYMENT_WEBHOOKS,
  WEBHOOK_INBOX_QUERY,
  PAYMENT_VERIFICATION,
  PAYMENT_FINDINGS,
} from './contracts/payments.js';
import { PostgresDurableOperations } from './infrastructure/durable-ops.js';
import { PostgresAttempts } from './infrastructure/postgres-attempts.js';
import { PostgresRefunds } from './infrastructure/postgres-refunds.js';
import { PostgresWebhookInbox } from './infrastructure/postgres-inbox.js';
import { PaymentOrderService } from './infrastructure/payment-service.js';
import { PaymentRefundService } from './infrastructure/refund-service.js';
import { PaymentPollerService, RefundRecoveryService } from './infrastructure/payment-recovery.js';
import { NightlyReconciliationService } from './infrastructure/reconciliation.js';
import { PaymentFraudSignalService } from './infrastructure/fraud-signals.js';
import { PaymentWebhookService } from './infrastructure/webhook-service.js';
import { FindingQueries } from './infrastructure/finding-queries.js';

export const WEBHOOK_JOB = 'process-webhook';

/** Local/test provider secret; production only accepts the razorpay secret. */
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';

const webhookServiceProvider: FactoryProvider<PaymentWebhookService> = {
  provide: PAYMENT_WEBHOOKS,
  inject: [
    PLATFORM_DATABASE,
    PostgresWebhookInbox,
    PostgresAttempts,
    PaymentRefundService,
    PAYMENT_GATEWAY,
    ConfigService,
    { token: PLATFORM_CONCERN_QUEUES, optional: true },
  ],
  useFactory: (
    handle: DatabaseHandle,
    inbox: PostgresWebhookInbox,
    attempts: PostgresAttempts,
    refunds: PaymentRefundService,
    gateway: PaymentGatewayPort,
    config: ConfigService,
    queues?: ConcernQueues,
  ) =>
    new PaymentWebhookService(
      handle.db,
      inbox,
      attempts,
      refunds,
      gateway,
      {
        [config.get('PAYMENTS_PROVIDER')]:
          config.get('PAYMENTS_PROVIDER') === 'fake'
            ? FAKE_WEBHOOK_SECRET
            : (config.get('RAZORPAY_WEBHOOK_SECRET') ?? ''),
      },
      queues
        ? (inboxId: string) => queues.enqueue('payments', WEBHOOK_JOB, { inboxId }, inboxId)
        : undefined,
    ),
};

/**
 * Provider-only payments module (P6.1). Surfaces and workers import it;
 * sibling modules depend only on contracts/payments.ts. The fake gateway is
 * the configured local/test provider; the environment schema rejects it in
 * production together with Razorpay test keys.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PAYMENT_FINDINGS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new FindingQueries(handle.db),
    },
    {
      provide: PaymentPollerService,
      inject: [PLATFORM_DATABASE, PostgresAttempts, PAYMENT_GATEWAY],
      useFactory: (h: DatabaseHandle, a: PostgresAttempts, g: PaymentGatewayPort) =>
        new PaymentPollerService(h.db, a, g),
    },
    {
      provide: RefundRecoveryService,
      inject: [PLATFORM_DATABASE, PaymentRefundService],
      useFactory: (h: DatabaseHandle, r: PaymentRefundService) =>
        new RefundRecoveryService(h.db, r),
    },
    {
      provide: NightlyReconciliationService,
      inject: [PLATFORM_DATABASE, PAYMENT_GATEWAY],
      useFactory: (h: DatabaseHandle, g: PaymentGatewayPort) =>
        new NightlyReconciliationService(h.db, g),
    },
    {
      provide: PAYMENT_FRAUD_SIGNALS,
      inject: [PLATFORM_DATABASE],
      useFactory: (h: DatabaseHandle) => new PaymentFraudSignalService(h.db),
    },
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentGatewayPort =>
        config.get('PAYMENTS_PROVIDER') === 'razorpay'
          ? new ResilientGateway(
              new RazorpayGateway({
                keyId: config.get('RAZORPAY_KEY_ID') ?? '',
                keySecret: config.get('RAZORPAY_KEY_SECRET') ?? '',
                webhookSecret: config.get('RAZORPAY_WEBHOOK_SECRET') ?? '',
                timeoutMs: 5000,
              }),
            )
          : new FakeGateway(),
    },
    {
      provide: PostgresDurableOperations,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresDurableOperations(handle.db),
    },
    {
      provide: PostgresAttempts,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresAttempts(handle.db),
    },
    {
      provide: PostgresWebhookInbox,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresWebhookInbox(handle.db),
    },
    {
      provide: PostgresRefunds,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresRefunds(handle.db),
    },
    {
      provide: PaymentOrderService,
      inject: [
        PLATFORM_DATABASE,
        PostgresAttempts,
        PostgresDurableOperations,
        PAYMENT_GATEWAY,
        ConfigService,
      ],
      useFactory: (handle, attempts, durable, gateway, config) =>
        new PaymentOrderService(
          handle.db,
          attempts,
          durable,
          gateway,
          config.get('PAYMENTS_PROVIDER') === 'razorpay' ? 'razorpay' : 'fake',
        ),
    },
    {
      provide: PaymentRefundService,
      inject: [
        PLATFORM_DATABASE,
        PostgresRefunds,
        PostgresDurableOperations,
        PAYMENT_GATEWAY,
        APP_CONFIG,
      ],
      useFactory: (
        handle: DatabaseHandle,
        refunds: PostgresRefunds,
        durable: PostgresDurableOperations,
        gateway: PaymentGatewayPort,
        config: AppConfig,
      ) => new PaymentRefundService(handle.db, refunds, durable, gateway, config),
    },
    webhookServiceProvider,
    { provide: PAYMENT_ORDERS, useExisting: PaymentOrderService },
    { provide: PAYMENT_VERIFICATION, useExisting: PaymentPollerService },
    { provide: PAYMENT_REFUNDS, useExisting: PaymentRefundService },
    { provide: WEBHOOK_INBOX_QUERY, useExisting: PAYMENT_WEBHOOKS },
  ],
  exports: [
    PAYMENT_FINDINGS,
    PaymentPollerService,
    RefundRecoveryService,
    NightlyReconciliationService,
    PAYMENT_FRAUD_SIGNALS,
    PAYMENT_GATEWAY,
    PAYMENT_ORDERS,
    PAYMENT_VERIFICATION,
    PAYMENT_REFUNDS,
    PAYMENT_WEBHOOKS,
    WEBHOOK_INBOX_QUERY,
  ],
})
export class PaymentsModule {}
