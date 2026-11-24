import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { NotificationsModule } from '../../../modules/notifications/notifications.module.js';
import { AdminNotificationsController } from './notifications.controller.js';
import { PushCampaignController } from './campaign.controller.js';
import { AdminAppContentController } from './app-content.controller.js';
import { NotificationTemplatesController } from './notification-templates.controller.js';

/** P9 admin notification surface: device tokens, preferences and inbox. */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [
    AdminNotificationsController,
    PushCampaignController,
    AdminAppContentController,
    NotificationTemplatesController,
  ],
})
export class AdminNotificationsSurfaceModule {}
