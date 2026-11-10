import { CustomerPaymentRecoveryController } from './payments.controller.js';
import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { CheckoutModule } from '../../../modules/checkout/checkout.module.js';
import { OrdersModule } from '../../../modules/orders/orders.module.js';
import { PaymentsModule } from '../../../modules/payments/payments.module.js';
import { InvoicingModule } from '../../../modules/invoicing/invoicing.module.js';
import {
  CustomerCheckoutController,
  CUSTOMER_CHECKOUT_IDEMPOTENCY,
} from './customer.controller.js';
@Module({
  imports: [IdentityModule, CheckoutModule, OrdersModule, PaymentsModule, InvoicingModule],
  controllers: [CustomerCheckoutController, CustomerPaymentRecoveryController],
  providers: [
    {
      provide: CUSTOMER_CHECKOUT_IDEMPOTENCY,
      inject: [PLATFORM_DATABASE],
      useFactory: (h: DatabaseHandle) => new IdempotencyStore(h.db),
    },
  ],
})
export class CustomerCheckoutSurfaceModule {}
