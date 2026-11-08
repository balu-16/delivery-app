import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { ConfigService } from '../../config/config.service.js';
import { CartModule } from '../cart/cart.module.js';
import { CouponsModule } from '../coupons/coupons.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ServiceabilityModule } from '../serviceability/serviceability.module.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { CART_INTENTS } from '../cart/contracts/intent.js';
import { CART_QUOTES } from '../cart/contracts/quote.js';
import { COUPON_REDEMPTIONS } from '../coupons/contracts/coupons.js';
import { INVENTORY_RESERVATIONS } from '../inventory/contracts/inventory.js';
import { WALLET_FUNDING, WALLET_SPENDER } from '../wallet/contracts/wallet.js';
import {
  PAYMENT_ORDERS,
  PAYMENT_VERIFICATION,
  PAYMENT_FRAUD_SIGNALS,
  type PaymentFraudSignals,
  type PaymentOrderOperations,
  type PaymentVerification,
} from '../payments/contracts/payments.js';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../payments/contracts/gateway.js';
import type { OrderOperations } from '../orders/contracts/orders.js';
import type { CheckoutOperations } from './contracts/checkout.js';
import { CHECKOUT_PAYMENTS } from './contracts/customer-payments.js';
import { CustomerPaymentService } from './infrastructure/customer-payments.js';
import { ORDERS } from '../orders/contracts/orders.js';
import { SERVICEABILITY, CAPACITY_CLAIMS } from '../serviceability/contracts/tokens.js';
import { APP_CONFIG } from '../app-config/contracts/config.js';
import { CHECKOUT } from './contracts/checkout.js';
import { CheckoutService, type CheckoutDependencies } from './infrastructure/checkout-service.js';

/**
 * Provider-only checkout module (P6.3). It composes the real P5 cart/quote
 * and P4 inventory contracts with the P6 wallet, payments and orders
 * contracts; surfaces import this module and use CHECKOUT only.
 */
@Module({
  imports: [
    AppConfigModule,
    CartModule,
    CouponsModule,
    InventoryModule,
    WalletModule,
    PaymentsModule,
    OrdersModule,
    ServiceabilityModule,
  ],
  providers: [
    {
      provide: CHECKOUT_PAYMENTS,
      inject: [
        PLATFORM_DATABASE,
        ORDERS,
        PAYMENT_ORDERS,
        PAYMENT_GATEWAY,
        PAYMENT_VERIFICATION,
        CHECKOUT,
      ],
      useFactory: (
        handle: DatabaseHandle,
        orders: OrderOperations,
        payments: PaymentOrderOperations,
        gateway: PaymentGatewayPort,
        verification: PaymentVerification,
        checkout: CheckoutOperations,
      ) => new CustomerPaymentService(handle.db, orders, payments, gateway, verification, checkout),
    },
    {
      provide: CHECKOUT,
      inject: [
        PLATFORM_DATABASE,
        CART_INTENTS,
        CART_QUOTES,
        SERVICEABILITY,
        CAPACITY_CLAIMS,
        COUPON_REDEMPTIONS,
        WALLET_SPENDER,
        WALLET_FUNDING,
        INVENTORY_RESERVATIONS,
        ORDERS,
        PAYMENT_ORDERS,
        APP_CONFIG,
        ConfigService,
        PAYMENT_FRAUD_SIGNALS,
      ],
      useFactory: (
        handle: DatabaseHandle,
        intents: CheckoutDependencies['intents'],
        quotes: CheckoutDependencies['quotes'],
        serviceability: CheckoutDependencies['serviceability'],
        capacity: CheckoutDependencies['capacity'],
        coupons: CheckoutDependencies['coupons'],
        wallet: CheckoutDependencies['wallet'],
        funding: CheckoutDependencies['funding'],
        inventory: CheckoutDependencies['inventory'],
        orders: CheckoutDependencies['orders'],
        paymentOrders: CheckoutDependencies['paymentOrders'],
        config: CheckoutDependencies['config'],
        env: ConfigService,
        fraud: PaymentFraudSignals,
      ) =>
        new CheckoutService(
          handle.db,
          {
            intents,
            quotes,
            serviceability,
            capacity,
            coupons,
            wallet,
            funding,
            inventory,
            orders,
            paymentOrders,
            config,
          },
          env,
          fraud,
        ),
    },
  ],
  exports: [CHECKOUT, CHECKOUT_PAYMENTS],
})
export class CheckoutModule {}
