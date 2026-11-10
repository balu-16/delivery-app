import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../../modules/app-config/app-config.module.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { InventoryModule } from '../../../modules/inventory/inventory.module.js';
import { StoreInventoryAdjustmentController } from './adjustment.controller.js';
import { StoreInventoryQualityController } from './quality.controller.js';
import { StoreInventoryCountController } from './count.controller.js';
import { StoreInventoryController } from './store.controller.js';
@Module({
  imports: [IdentityModule, InventoryModule, AppConfigModule],
  controllers: [
    StoreInventoryController,
    StoreInventoryCountController,
    StoreInventoryAdjustmentController,
    StoreInventoryQualityController,
  ],
})
export class StoreInventorySurfaceModule {}
