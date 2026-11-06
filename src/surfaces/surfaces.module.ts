import { Module } from '@nestjs/common';
import { CustomerPlacesSurfaceModule } from './customer/serviceability/p2.module.js';
import { StoreStatusSurfaceModule } from './store/serviceability/p2.module.js';
import { AdminStoresSurfaceModule } from './admin/serviceability/p2.module.js';
import {
  AdminIdentitySurfaceModule,
  CustomerIdentitySurfaceModule,
  RiderIdentitySurfaceModule,
  StoreIdentitySurfaceModule,
} from '../modules/identity/identity.module.js';

/** One composition module per audience keeps runtime routes and exports aligned. */
@Module({ imports: [CustomerIdentitySurfaceModule, CustomerPlacesSurfaceModule] })
export class CustomerSurfaceModule {}
@Module({ imports: [RiderIdentitySurfaceModule] })
export class RiderSurfaceModule {}
@Module({ imports: [StoreIdentitySurfaceModule, StoreStatusSurfaceModule] })
export class StoreSurfaceModule {}
@Module({ imports: [AdminIdentitySurfaceModule, AdminStoresSurfaceModule] })
export class AdminSurfaceModule {}
