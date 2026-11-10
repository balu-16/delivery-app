import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ORDERS, type OrderOperations } from '../orders/contracts/orders.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { CHECKOUT, type CheckoutOperations } from '../checkout/contracts/checkout.js';
import { SUBSCRIPTIONS, SUBSCRIPTION_ADMIN } from './contracts/subscriptions.js';
import { SubscriptionsService } from './infrastructure/subscriptions-service.js';
import { SubscriptionGeneration } from './infrastructure/generation.js';
import { SubscriptionObligationsModule } from './subscriptions-obligations.module.js';
import { PostgresSubscriptionAdmin } from './infrastructure/admin.js';

@Module({
  imports: [
    AppConfigModule,
    OrdersModule,
    CheckoutModule,
    IdentityModule,
    SubscriptionObligationsModule,
  ],
  providers: [
    {
      provide: SubscriptionsService,
      inject: [PLATFORM_DATABASE, APP_CONFIG, ORDERS, CHECKOUT],
      useFactory: (
        h: DatabaseHandle,
        c: AppConfig,
        o: OrderOperations,
        checkout: CheckoutOperations,
      ) => new SubscriptionsService(h.db, c, o, checkout),
    },
    { provide: SUBSCRIPTIONS, useExisting: SubscriptionsService },
    {
      provide: SUBSCRIPTION_ADMIN,
      inject: [PLATFORM_DATABASE, APP_CONFIG, IDENTITY_ACCESS],
      useFactory: (h: DatabaseHandle, c: AppConfig, identity: IdentityAccess) =>
        new PostgresSubscriptionAdmin(h.db, c, identity),
    },
    {
      provide: SubscriptionGeneration,
      inject: [PLATFORM_DATABASE, CHECKOUT, APP_CONFIG],
      useFactory: (h: DatabaseHandle, c: CheckoutOperations, config: AppConfig) =>
        new SubscriptionGeneration(h.db, c, config),
    },
  ],
  exports: [
    SubscriptionObligationsModule,
    SUBSCRIPTIONS,
    SUBSCRIPTION_ADMIN,
    SubscriptionsService,
    SubscriptionGeneration,
  ],
})
export class SubscriptionsModule {}
