import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PAYMENT_ORDERS, type PaymentOrderOperations } from '../payments/contracts/payments.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from '../compliance/contracts/approval.js';
import {
  WALLET_ADJUSTMENTS,
  WALLET_FUNDING,
  WALLET_SPENDER,
  WALLET_TOPUPS,
  WALLET_VIEWS,
} from './contracts/wallet.js';
import { WalletCreditService, WalletFundingService } from './infrastructure/postgres-credits.js';
import { WalletReversalService } from './infrastructure/postgres-reversals.js';
import { WalletSpendService } from './infrastructure/postgres-spend.js';
import { WalletPrimitives } from './infrastructure/postgres-wallet.js';
import { WalletService } from './infrastructure/wallet-facade.js';
import { PostgresWalletViews } from './infrastructure/wallet-views.js';
import { WalletTopupService } from './infrastructure/wallet-topups.js';
import { WalletAdjustmentService } from './infrastructure/wallet-adjustments.js';
import { WalletEventConsumer, WalletExpiryService } from './infrastructure/wallet-effects.js';

/**
 * Provider-only wallet module (P6.2, ADR 0008). Sibling modules depend only on
 * contracts/wallet.ts. PaymentsModule is imported for top-up intents; wallet
 * effects of payment events arrive through the outbox (`wallet` consumer).
 */
@Module({
  imports: [AppConfigModule, PaymentsModule, ComplianceModule],
  providers: [
    {
      provide: WalletPrimitives,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new WalletPrimitives(handle.db),
    },
    {
      provide: WalletSpendService,
      inject: [WalletPrimitives],
      useFactory: (primitives: WalletPrimitives) => new WalletSpendService(primitives),
    },
    {
      provide: WalletReversalService,
      inject: [WalletPrimitives],
      useFactory: (primitives: WalletPrimitives) => new WalletReversalService(primitives),
    },
    {
      provide: WalletCreditService,
      inject: [WalletPrimitives],
      useFactory: (primitives: WalletPrimitives) => new WalletCreditService(primitives),
    },
    {
      provide: WalletService,
      inject: [WalletSpendService, WalletReversalService, WalletCreditService],
      useFactory: (spend, reversals, credits) => new WalletService(spend, reversals, credits),
    },
    { provide: WALLET_SPENDER, useExisting: WalletService },
    {
      provide: WalletEventConsumer,
      inject: [WalletPrimitives, WalletService],
      useFactory: (primitives, spender) => new WalletEventConsumer(primitives, spender),
    },
    {
      provide: WalletExpiryService,
      inject: [PLATFORM_DATABASE, WalletPrimitives, WalletService],
      useFactory: (handle: DatabaseHandle, primitives, spender) =>
        new WalletExpiryService(handle.db, primitives, spender),
    },
    {
      provide: PostgresWalletViews,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresWalletViews(handle.db),
    },
    { provide: WALLET_VIEWS, useExisting: PostgresWalletViews },
    {
      provide: WalletTopupService,
      inject: [PLATFORM_DATABASE, WalletPrimitives, PAYMENT_ORDERS, APP_CONFIG, ConfigService],
      useFactory: (
        handle: DatabaseHandle,
        primitives: WalletPrimitives,
        orders: PaymentOrderOperations,
        config: AppConfig,
        env: ConfigService,
      ) =>
        new WalletTopupService(
          handle.db,
          primitives,
          orders,
          config,
          env.get('PAYMENTS_PROVIDER') === 'razorpay' ? (env.get('RAZORPAY_KEY_ID') ?? null) : null,
          env.get('PAYMENTS_PROVIDER') === 'razorpay' ? 'razorpay' : 'fake',
        ),
    },
    { provide: WALLET_TOPUPS, useExisting: WalletTopupService },
    {
      provide: WalletFundingService,
      inject: [WalletPrimitives],
      useFactory: (primitives: WalletPrimitives) => new WalletFundingService(primitives),
    },
    { provide: WALLET_FUNDING, useExisting: WalletFundingService },
    {
      provide: WalletAdjustmentService,
      inject: [WalletPrimitives, WalletService, APPROVAL_FACTORY],
      useFactory: (primitives, spender, factory: ApprovalFactory) =>
        new WalletAdjustmentService(primitives, spender, (actions) => factory.create(actions)),
    },
    { provide: WALLET_ADJUSTMENTS, useExisting: WalletAdjustmentService },
  ],
  exports: [
    WALLET_SPENDER,
    WALLET_VIEWS,
    WALLET_TOPUPS,
    WALLET_FUNDING,
    WALLET_ADJUSTMENTS,
    WalletEventConsumer,
    WalletExpiryService,
  ],
})
export class WalletModule {}
