import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { InventoryModule } from '../../../modules/inventory/inventory.module.js';
import { NotificationsModule } from '../../../modules/notifications/notifications.module.js';
import { RidersModule } from '../../../modules/riders/riders.module.js';
import { StoreCodReadsController } from './cod-reads.controller.js';
import { StoreInventoryReadsController } from './inventory-reads.controller.js';
import { StoreNotificationsUnreadController } from './notifications.controller.js';

/** P10 store-manager portal reads: inventory history, COD views, inbox mark-unread. */
@Module({
  imports: [IdentityModule, InventoryModule, RidersModule, NotificationsModule],
  controllers: [
    StoreInventoryReadsController,
    StoreCodReadsController,
    StoreNotificationsUnreadController,
  ],
})
export class StorePortalReadsSurfaceModule {}
