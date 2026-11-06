import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from '../compliance/contracts/approval.js';
import { INVENTORY_MANUAL_ADJUSTMENT } from './contracts/manual-adjustment.js';
import { PostgresManualAdjustment } from './infrastructure/manual-adjustment.js';
import type { InventoryAdjustments } from './contracts/adjustments.js';
import { INVENTORY_SHELF_LIFE } from './contracts/shelf-life.js';
import { PostgresShelfLife } from './infrastructure/shelf-life.js';
import { INVENTORY_RETURNS } from './contracts/returns.js';
import { PostgresInventoryReturns } from './infrastructure/returns.js';
import { INVENTORY_QUALITY } from './contracts/quality.js';
import { PostgresInventoryQuality } from './infrastructure/quality.js';
import { INVENTORY_ADJUSTMENTS } from './contracts/adjustments.js';
import { PostgresAdjustments } from './infrastructure/adjustments.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { INVENTORY_AVAILABILITY } from './contracts/availability.js';
import { INVENTORY_MANAGEMENT, INVENTORY_RESERVATIONS } from './contracts/inventory.js';
import { PostgresInventoryAvailability } from './infrastructure/postgres-availability.js';
import { PostgresInventoryManagement } from './infrastructure/management.js';
import { PostgresReservations } from './infrastructure/reservations.js';
import { InventoryExpiry } from './infrastructure/expiry.js';
@Module({
  imports: [IdentityModule, AppConfigModule, ComplianceModule],
  providers: [
    {
      provide: INVENTORY_AVAILABILITY,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresInventoryAvailability(db.db),
    },
    {
      provide: INVENTORY_MANAGEMENT,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresInventoryManagement(db.db, identity),
    },
    {
      provide: INVENTORY_RESERVATIONS,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresReservations(db.db),
    },
    {
      provide: INVENTORY_MANUAL_ADJUSTMENT,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, INVENTORY_ADJUSTMENTS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess, counts: InventoryAdjustments) =>
        new PostgresManualAdjustment(db.db, identity, counts),
    },
    {
      provide: INVENTORY_SHELF_LIFE,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresShelfLife(db.db, identity),
    },
    {
      provide: INVENTORY_RETURNS,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresInventoryReturns(db.db, identity),
    },
    {
      provide: INVENTORY_QUALITY,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresInventoryQuality(db.db, identity),
    },
    {
      provide: INVENTORY_ADJUSTMENTS,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, APP_CONFIG, APPROVAL_FACTORY],
      useFactory: (
        db: DatabaseHandle,
        identity: IdentityAccess,
        config: AppConfig,
        factory: ApprovalFactory,
      ) => new PostgresAdjustments(db.db, identity, config, factory),
    },
    {
      provide: InventoryExpiry,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new InventoryExpiry(db.db),
    },
  ],
  exports: [
    INVENTORY_AVAILABILITY,
    INVENTORY_MANAGEMENT,
    INVENTORY_RESERVATIONS,
    INVENTORY_ADJUSTMENTS,
    INVENTORY_QUALITY,
    INVENTORY_RETURNS,
    INVENTORY_SHELF_LIFE,
    INVENTORY_MANUAL_ADJUSTMENT,
    InventoryExpiry,
  ],
})
export class InventoryModule {}
