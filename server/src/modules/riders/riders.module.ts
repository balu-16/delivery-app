import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import {
  RIDER_ELIGIBILITY,
  RIDER_EARNINGS,
  RIDER_OPERATIONS,
  RIDER_CASH,
  COD_COLLECTIONS,
} from './contracts/riders.js';
import { PostgresRiderEligibility } from './infrastructure/postgres-eligibility.js';
import { PostgresRiderEarnings } from './infrastructure/postgres-rider-earnings.js';
import { PostgresRiderOperations } from './infrastructure/postgres-rider-operations.js';
import { PostgresRiderCash } from './infrastructure/postgres-rider-cash.js';
import { RidersMaintenance } from './infrastructure/maintenance.js';
import { RiderSettings } from './infrastructure/settings.js';

/**
 * Rider operations module (P8): online/shifts/heartbeat/capacity, the
 * cash-in-hand ledger, COD collection records (007 cod_collections) and
 * exactly-once earnings. Approval stays in P1; dispatch consumes
 * RIDER_ELIGIBILITY and dispatch deliver records earnings through
 * RIDER_EARNINGS in its own transaction.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: RiderSettings,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new RiderSettings(config),
    },
    {
      provide: PostgresRiderOperations,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresRiderOperations(handle.db),
    },
    { provide: RIDER_OPERATIONS, useExisting: PostgresRiderOperations },
    {
      provide: PostgresRiderCash,
      inject: [PLATFORM_DATABASE, RiderSettings],
      useFactory: (handle: DatabaseHandle, settings: RiderSettings) =>
        new PostgresRiderCash(handle.db, settings),
    },
    { provide: RIDER_CASH, useExisting: PostgresRiderCash },
    { provide: COD_COLLECTIONS, useExisting: PostgresRiderCash },
    {
      provide: PostgresRiderEarnings,
      inject: [PLATFORM_DATABASE, RiderSettings],
      useFactory: (handle: DatabaseHandle, settings: RiderSettings) =>
        new PostgresRiderEarnings(handle.db, () => settings.earnings()),
    },
    { provide: RIDER_EARNINGS, useExisting: PostgresRiderEarnings },
    {
      provide: PostgresRiderEligibility,
      inject: [PLATFORM_DATABASE, RiderSettings],
      useFactory: (handle: DatabaseHandle, settings: RiderSettings) =>
        new PostgresRiderEligibility(handle.db, settings),
    },
    { provide: RIDER_ELIGIBILITY, useExisting: PostgresRiderEligibility },
  ],
  exports: [RIDER_OPERATIONS, RIDER_CASH, COD_COLLECTIONS, RIDER_EARNINGS, RIDER_ELIGIBILITY],
})
export class RidersModule {}

/** Maintenance sweeps; rows stay authoritative and recover after restarts. */
@Injectable()
class RidersWorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<unknown>;
  private readonly maintenance: RidersMaintenance;
  constructor(
    @Inject(PLATFORM_DATABASE) handle: DatabaseHandle,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.maintenance = new RidersMaintenance(handle.db, new RiderSettings(config));
  }
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.run(), 30000);
    this.timer.unref();
  }
  private run(): void {
    if (this.active) return;
    this.active = this.maintenance
      .runOnce()
      .then(
        () => undefined,
        () => process.stderr.write('Riders maintenance failed; it will retry\n'),
      )
      .finally(() => {
        this.active = undefined;
      });
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

@Module({ imports: [RidersModule, AppConfigModule], providers: [RidersWorkerLifecycle] })
export class RidersWorkerModule {}
