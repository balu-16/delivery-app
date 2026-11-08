import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { NotificationsModule } from '../../../modules/notifications/notifications.module.js';
import { RiderNotificationsController } from './notifications.controller.js';

/** P9 rider notification surface: device tokens, preferences and inbox. */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [RiderNotificationsController],
})
export class RiderNotificationsSurfaceModule {}
