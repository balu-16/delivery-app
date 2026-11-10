import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { PickingModule } from '../../../modules/picking/picking.module.js';
import { InventoryModule } from '../../../modules/inventory/inventory.module.js';
import { StorePickTasksController } from './pick-tasks.controller.js';
import { StoreOrderFulfillmentController } from './orders.controller.js';

/** P7 store fulfillment surface: pick tasks, packing, handover and returns QC. */
@Module({
  imports: [IdentityModule, PickingModule, InventoryModule],
  controllers: [StorePickTasksController, StoreOrderFulfillmentController],
})
export class StorePickingSurfaceModule {}
