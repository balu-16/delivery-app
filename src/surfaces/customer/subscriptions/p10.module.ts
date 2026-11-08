import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { SubscriptionsModule } from '../../../modules/subscriptions/subscriptions.module.js';
import { CustomerSubscriptionsController } from './subscriptions.controller.js';
@Module({
  imports: [IdentityModule, SubscriptionsModule],
  controllers: [CustomerSubscriptionsController],
  providers: [
    {
      provide: IdempotencyStore,
      inject: [PLATFORM_DATABASE],
      useFactory: (h: DatabaseHandle) => new IdempotencyStore(h.db),
    },
  ],
})
export class CustomerSubscriptionsModule {}
