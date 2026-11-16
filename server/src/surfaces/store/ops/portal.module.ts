import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { PickingModule } from '../../../modules/picking/picking.module.js';
import { StoresModule } from '../../../modules/stores/stores.module.js';
import { StorePortalReadsModule } from '../../../modules/store-portal-reads/store-portal-reads.module.js';
import { NotificationsModule } from '../../../modules/notifications/notifications.module.js';
import { StoreOpsController } from './portal.controller.js';

/** Store-manager portal operations: dashboard, search, store status, returns workflow. */
@Module({
  imports: [
    IdentityModule,
    PickingModule,
    StoresModule,
    StorePortalReadsModule,
    NotificationsModule,
  ],
  controllers: [StoreOpsController],
})
export class StoreOpsSurfaceModule {}
