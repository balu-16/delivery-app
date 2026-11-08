import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module.js';
import { NotificationsWorkerLifecycle } from './infrastructure/notifications-worker.js';

/**
 * Worker-only composition: registers the 'notifications' outbox consumer and
 * the 'deliver' concern handler, and runs the recovery scan. Wired by the
 * composition root for APP_ROLE worker/all (see app-roles/roles.ts).
 */
@Module({ imports: [NotificationsModule], providers: [NotificationsWorkerLifecycle] })
export class NotificationsWorkerModule {}
