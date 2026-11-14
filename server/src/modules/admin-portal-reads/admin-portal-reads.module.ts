import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { MediaModule } from '../media/media.module.js';
import { RidersModule } from '../riders/riders.module.js';
import { TrackingModule } from '../tracking/tracking.module.js';
import { MEDIA_STORAGE, type StoragePort } from '../media/contracts/storage.js';
import { RIDER_ELIGIBILITY, type RiderEligibility } from '../riders/contracts/riders.js';
import { ADMIN_PORTAL_READS } from './contracts/admin-portal-reads.js';
import { PostgresAdminPortalReads } from './infrastructure/postgres.js';

/**
 * Admin portal read models (P14). Data access stays in this module; the
 * eligibility port is reused from riders so the candidate view cannot drift
 * from dispatch behavior. Fleet locations read rider_status directly (one
 * set-based query).
 */
@Module({
  imports: [RidersModule, TrackingModule, MediaModule],
  providers: [
    {
      provide: ADMIN_PORTAL_READS,
      inject: [PLATFORM_DATABASE, MEDIA_STORAGE, RIDER_ELIGIBILITY, ConfigService],
      useFactory: (
        handle: DatabaseHandle,
        storage: StoragePort,
        eligibility: RiderEligibility,
        config: ConfigService,
      ) => new PostgresAdminPortalReads(handle.db, storage, eligibility, config),
    },
  ],
  exports: [ADMIN_PORTAL_READS],
})
export class AdminPortalReadsModule {}
