import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PRIVATE_UPLOADS, type PrivateUploadPort } from '../identity/contracts/uploads.js';
import { SUPPORT } from './contracts/support.js';
import { PostgresSupport } from './infrastructure/postgres-support.js';
@Module({
  imports: [AppConfigModule, IdentityModule],
  providers: [
    {
      provide: SUPPORT,
      inject: [PLATFORM_DATABASE, APP_CONFIG, PRIVATE_UPLOADS],
      useFactory: (handle: DatabaseHandle, config: AppConfig, uploads: PrivateUploadPort) =>
        new PostgresSupport(handle.db, config, uploads),
    },
  ],
  exports: [SUPPORT],
})
export class SupportModule {}
