import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { CouponsModule } from '../../../modules/coupons/coupons.module.js';
import { IDEMPOTENCY_STORE } from './admin.controller.js';
import { AdminCouponsController } from './admin.controller.js';
@Module({
  imports: [IdentityModule, CouponsModule],
  controllers: [AdminCouponsController],
  providers: [
    {
      provide: IDEMPOTENCY_STORE,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new IdempotencyStore(db.db),
    },
  ],
})
export class AdminCouponsSurfaceModule {}
