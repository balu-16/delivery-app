import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { ADMIN_CONFIG, APP_CONFIG } from './contracts/config.js';
import { ConfigService } from './infrastructure/config-service.js';
import { CONFIG_HISTORY } from './contracts/history.js';
import { PostgresConfigHistory } from './infrastructure/history.js';
@Module({
  providers: [
    {
      provide: CONFIG_HISTORY,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresConfigHistory(db.db),
    },
    {
      provide: APP_CONFIG,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new ConfigService(db.db),
    },
    { provide: ADMIN_CONFIG, useExisting: APP_CONFIG },
  ],
  exports: [APP_CONFIG, ADMIN_CONFIG, CONFIG_HISTORY],
})
export class AppConfigModule {}
