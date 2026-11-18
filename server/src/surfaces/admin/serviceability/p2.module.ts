import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { StoresModule } from '../../../modules/stores/stores.module.js';
import { AppConfigModule } from '../../../modules/app-config/app-config.module.js';
import { AdminServiceabilityController } from './admin.controller.js';
import { StoreAdministrationController } from './administration.controller.js';
import { ServiceabilityModule } from '../../../modules/serviceability/serviceability.module.js';
import { AdminPincodeController } from './pincode.controller.js';
import { AdminSystemController } from './system.controller.js';
@Module({
  imports: [IdentityModule, StoresModule, AppConfigModule, ServiceabilityModule],
  controllers: [
    AdminServiceabilityController,
    StoreAdministrationController,
    AdminPincodeController,
    AdminSystemController,
  ],
})
export class AdminStoresSurfaceModule {}
