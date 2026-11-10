import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_CONCERN_QUEUES, PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import { SesEmail } from '../../adapters/email/ses-email.js';
import { SmtpEmail } from '../../adapters/email/smtp-email.js';
import { FcmPush } from '../../adapters/push/fcm-push.js';
import { FakePush } from '../../adapters/push/fake-push.js';
import { DisabledSms } from '../../adapters/sms/disabled.js';
import {
  DEVICE_TOKENS,
  EMAIL_PORT,
  NOTIFICATION_PIPELINE,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_VIEWS,
  PUSH_PORT,
  SMS_PORT,
  type EmailPort,
  type PushPort,
} from './contracts/notifications.js';
import { PostgresDeviceTokens } from './infrastructure/postgres-tokens.js';
import { PostgresNotificationPipeline } from './infrastructure/postgres-pipeline.js';
import { PostgresNotificationPreferences } from './infrastructure/postgres-preferences.js';
import { PostgresNotificationViews } from './infrastructure/postgres-views.js';
import { PUSH_CAMPAIGNS } from './contracts/campaigns.js';
import { PostgresPushCampaigns } from './infrastructure/postgres-campaigns.js';

/**
 * Notifications module (P9): event-matrix consumer, templates, inbox,
 * device tokens and preferences. Real providers activate only when their
 * env is complete (env.schema enforces SES_FROM_ADDRESS / FCM secret);
 * local development uses SMTP to Mailpit and the in-memory fake push.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PUSH_CAMPAIGNS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresPushCampaigns(handle.db),
    },
    {
      provide: PUSH_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PushPort =>
        config.get('PUSH_PROVIDER') === 'fcm'
          ? new FcmPush(
              config.get('FIREBASE_SERVICE_ACCOUNT_PATH')
                ? readFileSync(config.get('FIREBASE_SERVICE_ACCOUNT_PATH'), 'utf8')
                : config.get('FCM_SERVICE_ACCOUNT_JSON_SECRET'),
            )
          : new FakePush(),
    },
    {
      provide: EMAIL_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailPort =>
        config.get('EMAIL_PROVIDER') === 'ses'
          ? new SesEmail(config.get('AWS_REGION'), config.get('SES_FROM_ADDRESS')!)
          : new SmtpEmail(config.get('SMTP_URL')),
    },
    { provide: SMS_PORT, useFactory: () => new DisabledSms() },
    {
      provide: NOTIFICATION_PIPELINE,
      inject: [
        PLATFORM_DATABASE,
        PUSH_PORT,
        EMAIL_PORT,
        { token: PLATFORM_CONCERN_QUEUES, optional: true },
        APP_CONFIG,
      ],
      useFactory: (
        handle: DatabaseHandle,
        push: PushPort,
        email: EmailPort,
        concerns: ConcernQueues | undefined,
        appConfig: AppConfig,
      ) => new PostgresNotificationPipeline(handle.db, push, email, concerns, appConfig),
    },
    {
      provide: NOTIFICATION_VIEWS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresNotificationViews(handle.db),
    },
    {
      provide: DEVICE_TOKENS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresDeviceTokens(handle.db),
    },
    {
      provide: NOTIFICATION_PREFERENCES,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresNotificationPreferences(handle.db),
    },
  ],
  exports: [
    PUSH_CAMPAIGNS,
    NOTIFICATION_PIPELINE,
    NOTIFICATION_VIEWS,
    DEVICE_TOKENS,
    NOTIFICATION_PREFERENCES,
    PUSH_PORT,
    EMAIL_PORT,
    SMS_PORT,
  ],
})
export class NotificationsModule {}
