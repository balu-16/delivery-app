import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE, PLATFORM_REDIS } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { StoresModule } from '../stores/stores.module.js';
import {
  STORE_AVAILABILITY,
  STORE_SIGNALS,
  type StoreSignals,
} from '../stores/contracts/signals.js';
import type { StoreAvailability } from '../stores/contracts/schedule.js';
import { ConfigurableFakeMaps } from '../../adapters/maps/configurable-fake.js';
import { buildOlaConfig } from '../../adapters/maps/config.js';
import { OlaMaps } from '../../adapters/maps/ola.js';
import { ResilientMaps } from '../../adapters/maps/resilient.js';
import { createLogger } from '../../common/logging/logger.js';
import { ServiceabilityQuery } from './application/serviceability.js';
import { PostgresServiceability } from './infrastructure/postgres-serviceability.js';
import { PostgresCapacityClaims } from './infrastructure/postgres-capacity.js';
import { CAPACITY_CLAIMS, MAPS, SERVICEABILITY } from './contracts/tokens.js';
import { PINCODE_ADMIN } from './contracts/pincodes.js';
import { PostgresPincodeAdmin } from './infrastructure/pincode-admin.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';

/** Provider-only composition: each audience owns its own controllers. */
@Module({
  imports: [AppConfigModule, StoresModule, IdentityModule],
  providers: [
    {
      provide: PINCODE_ADMIN,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresPincodeAdmin(db.db, identity),
    },
    {
      provide: SERVICEABILITY,
      inject: [
        PLATFORM_DATABASE,
        APP_CONFIG,
        ConfigService,
        STORE_AVAILABILITY,
        STORE_SIGNALS,
        PLATFORM_REDIS,
      ],
      useFactory: (
        db: DatabaseHandle,
        config: AppConfig,
        env: ConfigService,
        availability: StoreAvailability,
        signals: StoreSignals,
        redis: Redis,
      ) => {
        const timezone = env.get('BUSINESS_TIMEZONE');
        const repository = new PostgresServiceability(
          db.db,
          timezone,
          availability,
          (storeId, at, tx) => signals.noRiders(storeId, at, tx),
          {
            get: (key) => redis.get(key),
            set: async (key, value, ttl) => {
              await redis.set(key, value, 'EX', ttl);
            },
          },
        );
        return new ServiceabilityQuery(repository, async (tx) => ({
          minMinutes: await config.get('etaMinMinutes', tx),
          maxMinutes: await config.get('etaMaxMinutes', tx),
        }));
      },
    },
    {
      provide: CAPACITY_CLAIMS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresCapacityClaims(handle.db),
    },
    {
      provide: MAPS,
      inject: [ConfigService, APP_CONFIG, PLATFORM_REDIS],
      useFactory: (env: ConfigService, config: AppConfig, redis: Redis) => {
        const settings = async () => {
          const keys = [
            'mapCacheTtlSeconds',
            'mapFallbackSpeedKph',
            'mapMatrixTopK',
            'mapMatrixMaxPairs',
          ] as const;
          if (config.getMany) {
            const values = await config.getMany(keys);
            return {
              cacheTtlSeconds: values.mapCacheTtlSeconds,
              speedKph: values.mapFallbackSpeedKph,
              topK: values.mapMatrixTopK,
              maxPairs: values.mapMatrixMaxPairs,
            };
          }
          const [cacheTtlSeconds, speedKph, topK, maxPairs] = await Promise.all([
            config.get('mapCacheTtlSeconds'),
            config.get('mapFallbackSpeedKph'),
            config.get('mapMatrixTopK'),
            config.get('mapMatrixMaxPairs'),
          ]);
          return { cacheTtlSeconds, speedKph, topK, maxPairs };
        };
        const logger = createLogger(env.get('LOG_LEVEL'));
        const cache = {
          get: (key: string) => redis.get(key),
          set: async (key: string, value: string, ttl: number) => {
            await redis.set(key, value, 'EX', ttl);
          },
        };
        if (env.get('MAPS_PROVIDER') === 'fake')
          return new ResilientMaps(
            new ConfigurableFakeMaps(async () => (await settings()).speedKph),
            cache,
            settings,
            'fake',
            logger,
          );
        const ola = new OlaMaps(
          buildOlaConfig({
            OLA_MAPS_API_KEY: env.get('OLA_MAPS_API_KEY'),
            OLA_MAPS_BASE_URL: env.get('OLA_MAPS_BASE_URL'),
            OLA_MAPS_TIMEOUT_MS: env.get('OLA_MAPS_TIMEOUT_MS'),
            OLA_MAPS_MAX_ATTEMPTS: env.get('OLA_MAPS_MAX_ATTEMPTS'),
            OLA_MAPS_BREAKER_FAILURES: env.get('OLA_MAPS_BREAKER_FAILURES'),
            OLA_MAPS_BREAKER_COOLDOWN_MS: env.get('OLA_MAPS_BREAKER_COOLDOWN_MS'),
            OLA_MAPS_AUTOCOMPLETE_PATH: env.get('OLA_MAPS_AUTOCOMPLETE_PATH'),
            OLA_MAPS_DETAILS_PATH: env.get('OLA_MAPS_DETAILS_PATH'),
            OLA_MAPS_GEOCODE_PATH: env.get('OLA_MAPS_GEOCODE_PATH'),
            OLA_MAPS_REVERSE_PATH: env.get('OLA_MAPS_REVERSE_PATH'),
            OLA_MAPS_DIRECTIONS_PATH: env.get('OLA_MAPS_DIRECTIONS_PATH'),
            OLA_MAPS_MATRIX_PATH: env.get('OLA_MAPS_MATRIX_PATH'),
          }),
          async () => {
            const s = await settings();
            return { topK: s.topK, maxPairs: s.maxPairs };
          },
          fetch,
          logger,
        );
        return new ResilientMaps(ola, cache, settings, 'ola', logger);
      },
    },
  ],
  exports: [SERVICEABILITY, MAPS, CAPACITY_CLAIMS, PINCODE_ADMIN],
})
export class ServiceabilityModule {}
