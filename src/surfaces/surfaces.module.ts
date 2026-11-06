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
  ],
})
export class CustomerSurfaceModule {}
@Module({ imports: [RiderIdentitySurfaceModule] })
export class RiderSurfaceModule {}
@Module({
  imports: [StoreIdentitySurfaceModule, StoreStatusSurfaceModule, StoreInventorySurfaceModule],
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
  ],
})
export class AdminSurfaceModule {}
