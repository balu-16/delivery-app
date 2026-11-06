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
import { OlaMaps } from '../../adapters/maps/ola.js';
import { ResilientMaps } from '../../adapters/maps/resilient.js';
import { ServiceabilityQuery } from './application/serviceability.js';
import { PostgresServiceability } from './infrastructure/postgres-serviceability.js';
import { MAPS, SERVICEABILITY } from './contracts/tokens.js';

/** Provider-only composition: each audience owns its own controllers. */
@Module({
  imports: [AppConfigModule, StoresModule],
  providers: [
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
          (storeId, at) => signals.noRiders(storeId, at),
          {
            get: (key) => redis.get(key),
            set: async (key, value, ttl) => {
              await redis.set(key, value, 'EX', ttl);
            },
          },
        );
        return new ServiceabilityQuery(repository, async () => ({
          minMinutes: await config.get('etaMinMinutes'),
          maxMinutes: await config.get('etaMaxMinutes'),
        }));
      },
    },
    {
      provide: MAPS,
      inject: [ConfigService, APP_CONFIG, PLATFORM_REDIS],
      useFactory: (env: ConfigService, config: AppConfig, redis: Redis) => {
        const settings = async () => ({
          cacheTtlSeconds: await config.get('mapCacheTtlSeconds'),
          speedKph: await config.get('mapFallbackSpeedKph'),
          topK: await config.get('mapMatrixTopK'),
          maxPairs: await config.get('mapMatrixMaxPairs'),
        });
        if (env.get('MAPS_PROVIDER') === 'fake')
          return new ResilientMaps(
            new ConfigurableFakeMaps(async () => (await settings()).speedKph),
            {
              get: (key) => redis.get(key),
              set: async (key, value, ttl) => {
                await redis.set(key, value, 'EX', ttl);
              },
            },
            settings,
          );
        const ola = new OlaMaps(
          {
            baseUrl: env.get('OLA_MAPS_BASE_URL'),
            apiKey: env.get('OLA_MAPS_API_KEY'),
            timeoutMs: env.get('OLA_MAPS_TIMEOUT_MS'),
            maxAttempts: env.get('OLA_MAPS_MAX_ATTEMPTS'),
            breakerFailures: env.get('OLA_MAPS_BREAKER_FAILURES'),
            breakerCooldownMs: env.get('OLA_MAPS_BREAKER_COOLDOWN_MS'),
            paths: {
              autocomplete: env.get('OLA_MAPS_AUTOCOMPLETE_PATH'),
              details: env.get('OLA_MAPS_DETAILS_PATH'),
              geocode: env.get('OLA_MAPS_GEOCODE_PATH'),
              reverse: env.get('OLA_MAPS_REVERSE_PATH'),
              directions: env.get('OLA_MAPS_DIRECTIONS_PATH'),
              matrix: env.get('OLA_MAPS_MATRIX_PATH'),
            },
          },
          async () => {
            const s = await settings();
            return { topK: s.topK, maxPairs: s.maxPairs };
          },
        );
        return new ResilientMaps(
          ola,
          {
            get: (key) => redis.get(key),
            set: async (key, value, ttl) => {
              await redis.set(key, value, 'EX', ttl);
            },
          },
          settings,
        );
      },
    },
  ],
  exports: [SERVICEABILITY, MAPS],
})
export class ServiceabilityModule {}
