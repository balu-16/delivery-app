import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { ReferralsModule } from '../../../modules/referrals/referrals.module.js';
import { PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.js';
import { CustomerReferralsController } from './referrals.controller.js';

@Module({
  imports: [IdentityModule, ReferralsModule],
  controllers: [CustomerReferralsController],
  providers: [
    {
      provide: IdempotencyStore,
      inject: [PLATFORM_DATABASE],
      useFactory: (h: DatabaseHandle) => new IdempotencyStore(h.db),
    },
  ],
})
export class CustomerReferralsModule {}
