import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { CartModule } from '../../../modules/cart/cart.module.js';
import { CouponsModule } from '../../../modules/coupons/coupons.module.js';
import { IDEMPOTENCY_STORE } from './customer.controller.js';
import { CustomerCartController } from './customer.controller.js';
@Module({
  imports: [IdentityModule, CartModule, CouponsModule],
  controllers: [CustomerCartController],
  providers: [
    {
      provide: IDEMPOTENCY_STORE,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new IdempotencyStore(db.db),
    },
  ],
})
export class CustomerCartSurfaceModule {}
