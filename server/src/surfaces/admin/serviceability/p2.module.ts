import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { StoresModule } from '../../../modules/stores/stores.module.js';
import { AppConfigModule } from '../../../modules/app-config/app-config.module.js';
import { AdminServiceabilityController } from './admin.controller.js';
import { StoreAdministrationController } from './administration.controller.js';
@Module({
  imports: [IdentityModule, StoresModule, AppConfigModule],
  controllers: [AdminServiceabilityController, StoreAdministrationController],
})
export class AdminStoresSurfaceModule {}
