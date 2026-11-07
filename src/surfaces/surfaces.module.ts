import { Module } from '@nestjs/common';
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
import { StorePickingSurfaceModule } from './store/picking/p7.module.js';
import { CustomerNotificationsSurfaceModule } from './customer/notifications/p9.module.js';
import { RiderNotificationsSurfaceModule } from './rider/notifications/p9.module.js';
import { StoreNotificationsSurfaceModule } from './store/notifications/p9.module.js';
import { AdminNotificationsSurfaceModule } from './admin/notifications/p9.module.js';
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
    CustomerNotificationsSurfaceModule,
  ],
})
export class CustomerSurfaceModule {}
@Module({ imports: [RiderIdentitySurfaceModule, RiderNotificationsSurfaceModule] })
export class RiderSurfaceModule {}
@Module({
  imports: [
    StoreIdentitySurfaceModule,
    StoreStatusSurfaceModule,
    StoreInventorySurfaceModule,
    StorePickingSurfaceModule,
    StoreNotificationsSurfaceModule,
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
    AdminNotificationsSurfaceModule,
  ],
})
export class AdminSurfaceModule {}
