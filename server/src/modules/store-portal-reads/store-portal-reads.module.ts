import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { STORE_PORTAL_READS } from './contracts/store-portal-reads.js';
import { PostgresStorePortalReads } from './infrastructure/postgres.js';

/** Cross-aggregate store portal reads (search, returns feed, inspection drafts). */
@Module({
  imports: [IdentityModule],
  providers: [
    {
      provide: STORE_PORTAL_READS,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresStorePortalReads(db.db, identity),
    },
  ],
  exports: [STORE_PORTAL_READS],
})
export class StorePortalReadsModule {}
