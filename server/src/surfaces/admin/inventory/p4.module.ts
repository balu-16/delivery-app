import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { InventoryModule } from '../../../modules/inventory/inventory.module.js';
import { AdminShelfLifeController } from './shelf-life.controller.js';
import { AdminInventoryController } from './admin.controller.js';
import { AdminInventoryApprovalController } from './approval.controller.js';
@Module({
  imports: [IdentityModule, InventoryModule],
  controllers: [
    AdminInventoryController,
    AdminShelfLifeController,
    AdminInventoryApprovalController,
  ],
})
export class AdminInventorySurfaceModule {}
