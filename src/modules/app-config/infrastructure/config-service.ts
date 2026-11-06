import { INVENTORY_CONFIG_DEFAULTS } from '../contracts/config.js';
import { z } from 'zod';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json } from '../../../platform/database/database.js';
import {
  FEATURE_FLAG_KEYS,
  type AdminConfig,
  type AppConfig,
  type ConfigKey,
  type ConfigValues,
  type FeatureFlagKey,
} from '../contracts/config.js';

const definitions = {
  inventoryReservationTtlSeconds: z.number().int().positive().default(900),
  inventoryAdjustmentApprovalUnits: z.number().int().positive().default(100),
  inventoryExpirySoonDays: z
    .number()
    .int()
    .positive()
    .default(INVENTORY_CONFIG_DEFAULTS.inventoryExpirySoonDays),
  catalogLowStockThreshold: z
    .number()
    .int()
    .positive()
    .default(INVENTORY_CONFIG_DEFAULTS.catalogLowStockThreshold),
  catalogMaxPerOrder: z.number().int().positive().default(10),
  catalogAllowedGstBps: z
    .array(z.number().int().min(0).max(10000))
    .min(1)
    .max(50)
    .default([0, 500, 1200, 1800, 2800]),
  catalogPriceApprovalCount: z.number().int().positive().default(20),
  catalogPriceApprovalPercent: z.number().int().min(0).max(10000).default(20),
  catalogImportMaxBytes: z.number().int().positive().default(10485760),
  catalogImportMaxRows: z.number().int().positive().default(10000),
  catalogImportBatchSize: z.number().int().min(1).max(1000).default(100),
  catalogSuggestCacheSeconds: z.number().int().min(1).max(3600).default(30),
  addressMaxPerUser: z.number().int().positive().default(10),
  addressPinMismatchMetres: z.number().positive().default(100),
  zoneMinAreaM2: z.number().positive().default(1),
  zoneMaxAreaM2: z.number().positive().default(1_000_000_000),
  mapCacheTtlSeconds: z.number().int().positive().default(2_592_000),
  mapMatrixTopK: z.number().int().min(1).max(50).default(5),
  mapMatrixMaxPairs: z.number().int().min(1).max(50).default(50),
  mapFallbackSpeedKph: z.number().positive().default(20),
  storeBacklogPauseThreshold: z.number().int().positive().default(100),
  storeNoRidersPauseMinutes: z.number().int().positive().default(15),
  etaMinMinutes: z.number().nonnegative().default(10),
  etaMaxMinutes: z.number().nonnegative().default(60),
  requiredRiderDocuments: z
    .array(z.string().min(1).max(80))
    .min(1)
    .max(32)
    .refine((values) => new Set(values).size === values.length, 'duplicate document type')
    .default(['licence', 'vehicle_rc', 'id_proof', 'bank_proof']),
  termsVersion: z.string().min(1).max(40).default('1'),
  privacyVersion: z.string().min(1).max(40).default('1'),
  maxPauseLengthDays: z.number().int().positive().default(90),
} satisfies { [K in ConfigKey]: z.ZodType<ConfigValues[K], unknown> };
const configSchema = z
  .object(definitions)
  .strict()
  .superRefine((v, ctx) => {
    if (v.zoneMinAreaM2 > v.zoneMaxAreaM2)
      ctx.addIssue({ code: 'custom', path: ['zoneMinAreaM2'], message: 'minimum exceeds maximum' });
    if (v.etaMinMinutes > v.etaMaxMinutes)
      ctx.addIssue({ code: 'custom', path: ['etaMinMinutes'], message: 'minimum exceeds maximum' });
    if (v.mapMatrixTopK > v.mapMatrixMaxPairs)
      ctx.addIssue({
        code: 'custom',
        path: ['mapMatrixTopK'],
        message: 'top K exceeds matrix pair limit',
      });
  });

/** DB versions are checked on every read, so invalidation loss cannot preserve stale policy. */
export class ConfigService implements AppConfig, AdminConfig {
  private readonly cache = new Map<
    ConfigKey,
    { version: string; value: ConfigValues[ConfigKey] }
  >();
  constructor(private readonly db: Database) {}
  async get<K extends ConfigKey>(key: K): Promise<ConfigValues[K]> {
    const result = await sql<{
      value: Json;
      version: string;
    }>`SELECT value,version::text FROM app_config WHERE key=${key}`.execute(this.db);
    const row = result.rows[0];
    const version = row?.version ?? 'default';
    const cached = this.cache.get(key);
    if (cached?.version === version) return structuredClone(cached.value) as ConfigValues[K];
    const value = definitions[key].parse(row?.value) as ConfigValues[K];
    this.cache.set(key, { version, value });
    return structuredClone(value);
  }
  invalidate(): void {
    this.cache.clear();
  }
  async update(actorId: string, key: ConfigKey, value: unknown): Promise<void> {
    if (!Object.hasOwn(definitions, key)) throw new Error('INVALID_CONFIG_KEY');
    const parsed = definitions[key].parse(value);
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(701001)`.execute(tx);
      const authorized = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='SUPER_ADMIN' FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!authorized.rows[0]) throw new Error('FORBIDDEN');
      const values = await sql<{
        key: ConfigKey;
        value: Json;
      }>`SELECT key,value FROM app_config`.execute(tx);
      const previous = values.rows.find((row) => row.key === key)?.value ?? null;
      const input: Record<string, unknown> = Object.fromEntries(
        values.rows.map((r) => [r.key, r.value]),
      );
      input[key] = parsed;
      configSchema.parse(input);
      await sql`INSERT INTO app_config(key,value,updated_by) VALUES (${key},${JSON.stringify(parsed)}::jsonb,${actorId}::uuid)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=app_config.version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`.execute(
        tx,
      );
      await sql`INSERT INTO config_history(id,actor_id,key,old_value,new_value) VALUES (${uuidV7()}::uuid,${actorId}::uuid,${key},${JSON.stringify(previous)}::jsonb,${JSON.stringify(parsed)}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'CONFIG_CHANGED','app_config',${key},${JSON.stringify({ before: previous, after: parsed })}::jsonb)`.execute(
        tx,
      );
    });
    this.invalidate();
  }
  async snapshot(): Promise<{ config: ConfigValues; flags: Record<FeatureFlagKey, boolean> }> {
    const config = Object.fromEntries(
      await Promise.all(
        (Object.keys(definitions) as ConfigKey[]).map(async (key) => [key, await this.get(key)]),
      ),
    ) as unknown as ConfigValues;
    const rows = await sql<{
      key: FeatureFlagKey;
      enabled: boolean;
    }>`SELECT key,enabled FROM feature_flags`.execute(this.db);
    const flags = Object.fromEntries(
      FEATURE_FLAG_KEYS.map((key) => [
        key,
        rows.rows.find((row) => row.key === key)?.enabled ?? false,
      ]),
    ) as Record<FeatureFlagKey, boolean>;
    return { config, flags };
  }
  async setFlag(actorId: string, key: FeatureFlagKey, enabled: boolean): Promise<void> {
    if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key) || typeof enabled !== 'boolean')
      throw new Error('INVALID_FLAG');
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(701001)`.execute(tx);
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='SUPER_ADMIN' FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      const old = await sql<{
        enabled: boolean;
      }>`SELECT enabled FROM feature_flags WHERE key=${key}`.execute(tx);
      await sql`INSERT INTO feature_flags(key,enabled,updated_by) VALUES (${key},${enabled},${actorId}::uuid) ON CONFLICT(key) DO UPDATE SET enabled=EXCLUDED.enabled,version=feature_flags.version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`.execute(
        tx,
      );
      const previous = old.rows[0]?.enabled ?? false;
      await sql`INSERT INTO config_history(id,actor_id,key,old_value,new_value) VALUES (${uuidV7()}::uuid,${actorId}::uuid,${key},${JSON.stringify(previous)}::jsonb,${JSON.stringify(enabled)}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'FLAG_CHANGED','feature_flag',${key},${JSON.stringify({ before: previous, after: enabled })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
