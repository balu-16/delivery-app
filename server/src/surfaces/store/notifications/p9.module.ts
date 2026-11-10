import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { NotificationsModule } from '../../../modules/notifications/notifications.module.js';
import { StoreNotificationsController } from './notifications.controller.js';

/** P9 store notification surface: device tokens, preferences and inbox. */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [StoreNotificationsController],
})
export class StoreNotificationsSurfaceModule {}
