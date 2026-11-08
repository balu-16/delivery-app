import { INVENTORY_RETURNS, type InventoryReturns } from '../inventory/contracts/returns.js';
import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { ConfigService } from '../../config/config.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { CouponsModule } from '../coupons/coupons.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { CartModule } from '../cart/cart.module.js';
import {
  INVENTORY_RESERVATIONS,
  type InventoryReservations,
} from '../inventory/contracts/inventory.js';
import { COUPON_REDEMPTIONS, type CouponRedemptions } from '../coupons/contracts/coupons.js';
import { CART_SERVICE, type CartService } from '../cart/contracts/cart.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import {
  WALLET_FUNDING,
  WALLET_SPENDER,
  type WalletFunding,
  type WalletSpender,
} from '../wallet/contracts/wallet.js';
import { PAYMENT_REFUNDS, type PaymentRefundOperations } from '../payments/contracts/payments.js';
import {
  ORDER_CODES,
  ORDER_INTEGRATION,
  ORDER_PICKING_INTEGRATION,
  ORDERS,
} from './contracts/orders.js';
import { PostgresOrderAggregate } from './infrastructure/postgres-orders.js';
import { OrderCodeService } from './infrastructure/delivery-codes.js';
import { OrderCompensationService } from './infrastructure/order-compensation.js';
import { OrderConfirmationService } from './infrastructure/order-confirmation.js';
import { OrderMutationsService } from './infrastructure/order-queries.js';
import { OrderService } from './infrastructure/order-service.js';
import { OrderPaymentEventConsumer } from './infrastructure/order-consumer.js';
import { OrderPickingIntegration } from './infrastructure/picking-integration.js';
import { OrderIntegrationService } from './infrastructure/order-integration.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { ServiceabilityModule } from '../serviceability/serviceability.module.js';
import { CAPACITY_CLAIMS } from '../serviceability/contracts/tokens.js';
import type { CapacityClaims } from '../serviceability/contracts/serviceability.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from '../compliance/contracts/approval.js';
import { ORDER_ADMINISTRATION } from './contracts/administration.js';
import { OrderAdministrationService } from './infrastructure/administration.js';
import { ORDER_HOLDS } from './contracts/hold.js';
import { OrderHoldService } from './infrastructure/order-holds.js';

/**
 * Provider-only orders module (P6.3/P6.4). Sibling modules depend only on
 * contracts/orders.ts; surfaces and the composition root import this module
 * to obtain ORDERS / ORDER_CODES. The injected sibling contracts arrive
 * through their own provider-only modules (plan D04).
 */
@Module({
  imports: [
    ComplianceModule,
    ServiceabilityModule,
    PaymentsModule,
    AppConfigModule,
    InventoryModule,
    CouponsModule,
    WalletModule,
    CartModule,
  ],
  providers: [
    {
      provide: ORDER_HOLDS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new OrderHoldService(handle.db),
    },
    {
      provide: ORDER_ADMINISTRATION,
      inject: [APPROVAL_FACTORY, OrderService, PAYMENT_REFUNDS, PLATFORM_DATABASE, APP_CONFIG],
      useFactory: (
        factory: ApprovalFactory,
        orders: OrderService,
        refunds: PaymentRefundOperations,
        handle: DatabaseHandle,
        config: AppConfig,
      ) => new OrderAdministrationService(factory, orders, refunds, handle.db, config),
    },
    {
      provide: PostgresOrderAggregate,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresOrderAggregate(handle.db),
    },
    {
      provide: OrderCodeService,
      inject: [PLATFORM_DATABASE, ConfigService, APP_CONFIG],
      useFactory: (handle: DatabaseHandle, runtime: ConfigService, config: AppConfig) =>
        new OrderCodeService(handle.db, runtime, config),
    },
    {
      provide: OrderConfirmationService,
      inject: [
        PostgresOrderAggregate,
        INVENTORY_RESERVATIONS,
        COUPON_REDEMPTIONS,
        OrderCodeService,
        APP_CONFIG,
      ],
      useFactory: (
        aggregate: PostgresOrderAggregate,
        reservations: InventoryReservations,
        coupons: CouponRedemptions,
        codes: OrderCodeService,
        config: AppConfig,
      ) => new OrderConfirmationService(aggregate, reservations, coupons, codes, config),
    },
    {
      provide: OrderCompensationService,
      inject: [
        PLATFORM_DATABASE,
        PostgresOrderAggregate,
        INVENTORY_RESERVATIONS,
        COUPON_REDEMPTIONS,
        PAYMENT_REFUNDS,
        WALLET_SPENDER,
        CAPACITY_CLAIMS,
        INVENTORY_RETURNS,
      ],
      useFactory: (
        handle: DatabaseHandle,
        aggregate: PostgresOrderAggregate,
        reservations: InventoryReservations,
        coupons: CouponRedemptions,
        refunds: PaymentRefundOperations,
        wallet: WalletSpender,
        capacity: CapacityClaims,
        returns: InventoryReturns,
      ) =>
        new OrderCompensationService(
          handle.db,
          aggregate,
          reservations,
          coupons,
          refunds,
          wallet,
          capacity,
          returns,
        ),
    },
    {
      provide: OrderMutationsService,
      inject: [PLATFORM_DATABASE, PostgresOrderAggregate, CART_SERVICE],
      useFactory: (handle: DatabaseHandle, aggregate: PostgresOrderAggregate, carts: CartService) =>
        new OrderMutationsService(handle.db, aggregate, carts),
    },
    {
      provide: OrderService,
      inject: [
        PLATFORM_DATABASE,
        PostgresOrderAggregate,
        OrderConfirmationService,
        OrderCompensationService,
        INVENTORY_RESERVATIONS,
        COUPON_REDEMPTIONS,
        WALLET_SPENDER,
        WALLET_FUNDING,
        OrderMutationsService,
        CAPACITY_CLAIMS,
      ],
      useFactory: (
        handle: DatabaseHandle,
        aggregate: PostgresOrderAggregate,
        confirmation: OrderConfirmationService,
        compensation: OrderCompensationService,
        reservations: InventoryReservations,
        coupons: CouponRedemptions,
        wallet: WalletSpender,
        funding: WalletFunding,
        mutations: OrderMutationsService,
        capacity: CapacityClaims,
      ) =>
        new OrderService(
          handle.db,
          aggregate,
          confirmation,
          compensation,
          reservations,
          coupons,
          wallet,
          funding,
          mutations,
          capacity,
        ),
    },
    {
      provide: OrderIntegrationService,
      inject: [OrderService, PostgresOrderAggregate],
      useFactory: (orders: OrderService, aggregate: PostgresOrderAggregate) =>
        new OrderIntegrationService(orders, aggregate),
    },
    {
      provide: OrderPaymentEventConsumer,
      inject: [PostgresOrderAggregate, OrderConfirmationService, PAYMENT_REFUNDS, OrderService],
      useFactory: (
        aggregate: PostgresOrderAggregate,
        confirmation: OrderConfirmationService,
        refunds: PaymentRefundOperations,
        orders: OrderService,
      ) =>
        new OrderPaymentEventConsumer(
          aggregate,
          confirmation,
          refunds,
          (orderId, actor, tx) => orders.reinstate(orderId, actor, tx),
          (orderId, tx) => orders.expirePending(orderId, tx),
        ),
    },
    {
      provide: OrderPickingIntegration,
      inject: [PLATFORM_DATABASE, OrderService, PAYMENT_REFUNDS],
      useFactory: (
        handle: DatabaseHandle,
        orders: OrderService,
        refunds: PaymentRefundOperations,
      ) => new OrderPickingIntegration(handle.db, orders, refunds),
    },
    { provide: ORDER_PICKING_INTEGRATION, useExisting: OrderPickingIntegration },
    { provide: ORDERS, useExisting: OrderService },
    { provide: ORDER_CODES, useExisting: OrderCodeService },
    { provide: ORDER_INTEGRATION, useExisting: OrderIntegrationService },
  ],
  exports: [
    ORDER_HOLDS,
    ORDER_ADMINISTRATION,
    ORDERS,
    ORDER_CODES,
    ORDER_INTEGRATION,
    ORDER_PICKING_INTEGRATION,
    OrderPaymentEventConsumer,
    OrderService,
    OrderCompensationService,
    OrderConfirmationService,
    PostgresOrderAggregate,
    OrderIntegrationService,
  ],
})
export class OrdersModule {}
