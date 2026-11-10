import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { RATINGS } from './contracts/ratings.js';
import { PostgresRatings } from './infrastructure/postgres-ratings.js';
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: RATINGS,
      inject: [PLATFORM_DATABASE, APP_CONFIG],
      useFactory: (handle: DatabaseHandle, config: AppConfig) =>
        new PostgresRatings(handle.db, config),
    },
  ],
  exports: [RATINGS],
})
export class RatingsModule {}
