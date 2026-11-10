import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_DATABASE, PLATFORM_REDIS } from '../../platform/contracts/runtime.js';
import type { Database, DatabaseHandle } from '../../platform/database/database.js';
import type { Redis } from 'ioredis';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import {
  ACTIVE_ORDER_RESOLVER_HOLDER,
  ETA_PROVIDER,
  LOCATION_INGEST,
  NAMESPACE_REGISTRY,
  REALTIME_BROADCASTS,
  RIDER_GEO,
  RIDER_LOCATION_READS,
} from './contracts/tokens.js';
import { ActiveOrderResolverHolder } from './contracts/tracking.js';
import { TRACKING_PRIVACY } from './contracts/privacy.js';
import { PostgresTrackingPrivacy } from './infrastructure/privacy.js';
import { TrackingMaintenance } from './infrastructure/maintenance.js';
import { PostgresLocationIngest } from './infrastructure/postgres-location-ingest.js';
import {
  ConfigEtaProvider,
  PostgresLocationReads,
} from './infrastructure/postgres-location-reads.js';
import { RedisRiderGeo } from './infrastructure/redis-geo.js';
import { BroadcastsFactory, NamespaceRegistry } from './infrastructure/realtime-broadcasts.js';
import { TrackingSettings } from './infrastructure/settings.js';

/**
 * Tracking module (P8): GPS ingest with integrity/sampling rules, the Redis
 * GEO candidate index (a prefilter only), location reads and the v1 ETA
 * provider. Realtime emission is a soft dependency (no-op without the
 * platform gateway); dispatch binds ACTIVE_ORDER_RESOLVER at boot through
 * the holder, so tracking never imports dispatch.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: TrackingSettings,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new TrackingSettings(config),
    },
    NamespaceRegistry,
    { provide: NAMESPACE_REGISTRY, useExisting: NamespaceRegistry },
    BroadcastsFactory,
    {
      provide: REALTIME_BROADCASTS,
      inject: [BroadcastsFactory],
      useFactory: (factory: BroadcastsFactory) => factory.build(),
    },
    {
      provide: RedisRiderGeo,
      inject: [PLATFORM_REDIS],
      useFactory: (redis: Redis) => new RedisRiderGeo(redis),
    },
    { provide: RIDER_GEO, useExisting: RedisRiderGeo },
    {
      provide: TRACKING_PRIVACY,
      inject: [PLATFORM_DATABASE, RedisRiderGeo],
      useFactory: (db: DatabaseHandle, geo: RedisRiderGeo) =>
        new PostgresTrackingPrivacy(db.db, geo),
    },
    {
      provide: PostgresLocationReads,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresLocationReads(handle.db),
    },
    { provide: RIDER_LOCATION_READS, useExisting: PostgresLocationReads },
    {
      provide: ConfigEtaProvider,
      inject: [TrackingSettings],
      useFactory: (settings: TrackingSettings) => new ConfigEtaProvider(() => settings.eta()),
    },
    { provide: ETA_PROVIDER, useExisting: ConfigEtaProvider },
    ActiveOrderResolverHolder,
    { provide: ACTIVE_ORDER_RESOLVER_HOLDER, useExisting: ActiveOrderResolverHolder },
    {
      provide: PostgresLocationIngest,
      inject: [
        PLATFORM_DATABASE,
        RedisRiderGeo,
        ActiveOrderResolverHolder,
        REALTIME_BROADCASTS,
        TrackingSettings,
      ],
      useFactory: (
        handle: DatabaseHandle,
        geo: RedisRiderGeo,
        holder: ActiveOrderResolverHolder,
        broadcasts: Awaited<ReturnType<BroadcastsFactory['build']>>,
        settings: TrackingSettings,
      ) =>
        new PostgresLocationIngest(
          handle.db,
          geo,
          holder,
          broadcasts,
          () => settings.integrity(),
          () => settings.number('riderStaleLocationSeconds'),
        ),
    },
    { provide: LOCATION_INGEST, useExisting: PostgresLocationIngest },
  ],
  exports: [
    LOCATION_INGEST,
    TRACKING_PRIVACY,
    RIDER_GEO,
    RIDER_LOCATION_READS,
    ETA_PROVIDER,
    REALTIME_BROADCASTS,
    ACTIVE_ORDER_RESOLVER_HOLDER,
    NAMESPACE_REGISTRY,
  ],
})
export class TrackingModule {}

@Injectable()
class TrackingWorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<unknown>;
  private readonly db: Database;
  private readonly settings: TrackingSettings;
  constructor(
    @Inject(PLATFORM_DATABASE) handle: DatabaseHandle,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.db = handle.db;
    this.settings = new TrackingSettings(config);
  }
  onApplicationBootstrap(): void {
    this.run();
    this.timer = setInterval(() => this.run(), 60000);
    this.timer.unref();
  }
  private run(): void {
    if (this.active) return;
    this.active = (async () => {
      const maintenance = new TrackingMaintenance(
        this.db,
        await this.settings.number('locationRetentionDays'),
      );
      await maintenance.runOnce();
    })()
      .catch(() => {
        process.stderr.write('Tracking maintenance failed; it will retry\n');
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

@Module({ imports: [TrackingModule, AppConfigModule], providers: [TrackingWorkerLifecycle] })
export class TrackingWorkerModule {}
