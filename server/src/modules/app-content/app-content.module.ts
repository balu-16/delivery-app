import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { APP_CONTENT } from './contracts/app-content.js';
import { PostgresAppContent } from './infrastructure/postgres-app-content.js';

/** App content module (customize2 §3E): admin-managed slots rendered by both apps. */
@Module({
  providers: [
    {
      provide: APP_CONTENT,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresAppContent(handle.db),
    },
  ],
  exports: [APP_CONTENT],
})
export class AppContentModule {}
