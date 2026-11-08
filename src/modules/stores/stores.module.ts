import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { PostgresStoreManagement } from './infrastructure/store-status.js';
import { STORE_MANAGEMENT, ZONES } from './contracts/tokens.js';
import { STORE_AVAILABILITY, STORE_SIGNALS } from './contracts/signals.js';
import { PostgresStoreAvailability } from './infrastructure/postgres-availability.js';
import { PostgresZones } from './infrastructure/postgres-zones.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { PostgresStoreSignals } from './infrastructure/store-signals.js';
import { STORE_ADMINISTRATION } from './contracts/administration.js';
import { PostgresStoreAdministration } from './infrastructure/store-administration.js';
@Module({
  imports: [IdentityModule, AppConfigModule],
  providers: [
    {
      provide: STORE_MANAGEMENT,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresStoreManagement(db.db, identity),
    },
    {
      provide: STORE_ADMINISTRATION,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresStoreAdministration(db.db, identity),
    },
    {
      provide: ZONES,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresZones(db.db, identity),
    },
    {
      provide: STORE_AVAILABILITY,
      inject: [PLATFORM_DATABASE, ConfigService],
      useFactory: (db: DatabaseHandle, config: ConfigService) =>
        new PostgresStoreAvailability(db.db, config.get('BUSINESS_TIMEZONE')),
    },
    {
      provide: STORE_SIGNALS,
      inject: [PLATFORM_DATABASE, APP_CONFIG],
      useFactory: (db: DatabaseHandle, config: AppConfig) =>
        new PostgresStoreSignals(db.db, async (tx) => ({
          backlog: await config.get('storeBacklogPauseThreshold', tx),
          minutes: await config.get('storeNoRidersPauseMinutes', tx),
        })),
    },
  ],
  exports: [ZONES, STORE_MANAGEMENT, STORE_ADMINISTRATION, STORE_AVAILABILITY, STORE_SIGNALS],
})
export class StoresModule {}
