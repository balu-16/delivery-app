import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { NotificationsModule } from '../../../modules/notifications/notifications.module.js';
import { CustomerNotificationsController } from './notifications.controller.js';

/** P9 customer notification surface: device tokens, preferences and inbox. */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [CustomerNotificationsController],
})
export class CustomerNotificationsSurfaceModule {}
