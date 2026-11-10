import { Module } from '@nestjs/common';
import { CustomerSubscriptionsModule } from './customer/subscriptions/p10.module.js';
import { AdminSubscriptionsModule } from './admin/subscriptions/p10.module.js';
import { CustomerP11Module } from './customer/p11/p11.module.js';
import { RiderP11Module } from './rider/p11/p11.module.js';
import { AdminP11Module } from './admin/p11/p11.module.js';
import { AdminComplianceSurfaceModule } from './admin/compliance/p12.module.js';
import { CustomerPrivacySurfaceModule } from './customer/privacy/p12.module.js';
import { AdminReportsSurfaceModule } from './admin/reports/p12.module.js';
import { CustomerPlacesSurfaceModule } from './customer/serviceability/p2.module.js';
import { StoreStatusSurfaceModule } from './store/serviceability/p2.module.js';
import { AdminStoresSurfaceModule } from './admin/serviceability/p2.module.js';
import { CustomerCatalogSurfaceModule } from './customer/catalog/p3.module.js';
import { AdminCatalogSurfaceModule } from './admin/catalog/p3.module.js';
import { AdminCatalogMediaSurfaceModule } from './admin/media/p3.module.js';
import { AdminCatalogImportSurfaceModule } from './admin/catalog-imports/p3.module.js';
import { CatalogMediaSurfaceModule } from './media/p3.module.js';
import { StoreInventorySurfaceModule } from './store/inventory/p4.module.js';
import { AdminInventorySurfaceModule } from './admin/inventory/p4.module.js';
import { CustomerCartSurfaceModule } from './customer/cart/p5.module.js';
import { AdminCouponsSurfaceModule } from './admin/coupons/p5.module.js';
import { StorePickingSurfaceModule } from './store/picking/p7.module.js';
import { CustomerNotificationsSurfaceModule } from './customer/notifications/p9.module.js';
import { RiderNotificationsSurfaceModule } from './rider/notifications/p9.module.js';
import { StoreNotificationsSurfaceModule } from './store/notifications/p9.module.js';
import { AdminNotificationsSurfaceModule } from './admin/notifications/p9.module.js';
import { CustomerCheckoutSurfaceModule } from './customer/checkout/p6.module.js';
import { CustomerPaymentsSurfaceModule } from './customer/payments/p6.module.js';
import { CustomerWalletSurfaceModule } from './customer/wallet/p6.module.js';
import { AdminWalletSurfaceModule } from './admin/wallet/p6.module.js';
import { CustomerTrackingSurfaceModule } from './customer/tracking/p8.module.js';
import { RiderDispatchSurfaceModule } from './rider/dispatch/p8.module.js';
import { StoreDispatchSurfaceModule } from './store/dispatch/p8.module.js';
import { AdminDispatchSurfaceModule } from './admin/dispatch/p8.module.js';
import { AdminCommerceSurfaceModule } from './admin/orders/p6.module.js';
import {
  AdminIdentitySurfaceModule,
  CustomerIdentitySurfaceModule,
  RiderIdentitySurfaceModule,
  StoreIdentitySurfaceModule,
} from '../modules/identity/identity.module.js';

/** One composition module per audience keeps runtime routes and exports aligned. */
@Module({
  imports: [
    CustomerIdentitySurfaceModule,
    CustomerPlacesSurfaceModule,
    CustomerCatalogSurfaceModule,
    CatalogMediaSurfaceModule,
    CustomerCartSurfaceModule,
    CustomerNotificationsSurfaceModule,
    CustomerCheckoutSurfaceModule,
    CustomerPaymentsSurfaceModule,
    CustomerWalletSurfaceModule,
    CustomerTrackingSurfaceModule,
    CustomerSubscriptionsModule,
    CustomerP11Module,
    CustomerPrivacySurfaceModule,
  ],
})
export class CustomerSurfaceModule {}
@Module({
  imports: [
    RiderIdentitySurfaceModule,
    RiderNotificationsSurfaceModule,
    RiderDispatchSurfaceModule,
    RiderP11Module,
  ],
})
export class RiderSurfaceModule {}
@Module({
  imports: [
    StoreIdentitySurfaceModule,
    StoreStatusSurfaceModule,
    StoreInventorySurfaceModule,
    StorePickingSurfaceModule,
    StoreNotificationsSurfaceModule,
    StoreDispatchSurfaceModule,
  ],
})
export class StoreSurfaceModule {}
@Module({
  imports: [
    AdminIdentitySurfaceModule,
    AdminStoresSurfaceModule,
    AdminCatalogSurfaceModule,
    AdminCatalogMediaSurfaceModule,
    AdminCatalogImportSurfaceModule,
    CatalogMediaSurfaceModule,
    AdminInventorySurfaceModule,
    AdminCouponsSurfaceModule,
    AdminNotificationsSurfaceModule,
    AdminWalletSurfaceModule,
    AdminDispatchSurfaceModule,
    AdminCommerceSurfaceModule,
    AdminSubscriptionsModule,
    AdminP11Module,
    AdminComplianceSurfaceModule,
    AdminReportsSurfaceModule,
  ],
})
export class AdminSurfaceModule {}
