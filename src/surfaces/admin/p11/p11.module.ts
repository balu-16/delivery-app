import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { SupportModule } from '../../../modules/support/support.module.js';
import { RatingsModule } from '../../../modules/ratings/ratings.module.js';
import { PayoutsModule } from '../../../modules/payouts/payouts.module.js';
import { OrdersModule } from '../../../modules/orders/orders.module.js';
import { PaymentsModule } from '../../../modules/payments/payments.module.js';
import { AdminP11Controller } from './p11.controller.js';
@Module({
  imports: [
    IdentityModule,
    SupportModule,
    RatingsModule,
    PayoutsModule,
    PaymentsModule,
    OrdersModule,
  ],
  controllers: [AdminP11Controller],
})
export class AdminP11Module {}
