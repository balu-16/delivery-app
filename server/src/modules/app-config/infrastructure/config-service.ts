import { INVENTORY_CONFIG_DEFAULTS } from '../contracts/config.js';
import { phaseDefinitions } from './phase-definitions.js';
import { z } from 'zod';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import {
  FEATURE_FLAG_KEYS,
  type AdminConfig,
  type AppConfig,
  type ConfigChange,
  type ConfigChangeResult,
  type ConfigKey,
  type ConfigValues,
  type DeliveryFeeSlab,
  type FeatureFlagKey,
} from '../contracts/config.js';

function assertVersion(expected: string | undefined, actual: string): void {
  if (expected === undefined) return;
  if (!/^\d+$/.test(expected)) throw new Error('CONCURRENT_MODIFICATION');
  if (BigInt(expected) !== BigInt(actual)) throw new Error('CONCURRENT_MODIFICATION');
}

async function assertSuperAdmin(actorId: string, tx: TransactionContext): Promise<void> {
  const authorized = await sql<{
    id: string;
  }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='SUPER_ADMIN' FOR SHARE OF u,r`.execute(
    tx,
  );
  if (!authorized.rows[0]) throw new Error('FORBIDDEN');
}

const paise = z.string().regex(/^[0-9]+$/, 'paise must be a nonnegative decimal string');
const feeSlabs = z
  .array(
    z
      .object({ maxOrderValuePaise: paise.nullable(), feePaise: paise })
      .strict() satisfies z.ZodType<DeliveryFeeSlab, unknown>,
  )
  .min(1)
  .max(20);

const definitions = {
  ...phaseDefinitions,
  agent_max_tool_calls_per_turn: z.number().int().min(1).max(100).default(12),
  agent_max_steps_per_run: z.number().int().min(1).max(200).default(30),
  agent_daily_turn_limit_per_user: z.number().int().min(1).max(10000).default(20),
  agent_daily_token_budget_per_user: z.number().int().min(1).max(10000000).default(50000),
  agent_confirm_ttl_seconds: z.number().int().min(30).max(86400).default(300),
  agent_max_order_value_paise: paise.default('500000'),
  agent_max_qty_per_line: z.number().int().min(1).max(1000).default(10),
  agent_history_max_tokens: z.number().int().min(256).max(100000).default(8000),
  agent_thread_retention_days: z.number().int().min(1).max(365).default(30),
  agent_proactive_nudges_enabled: z.boolean().default(false),
  agent_nudge_max_per_week: z.number().int().min(0).max(7).default(1),
  agent_trusted_mode_enabled: z.literal(false).default(false),
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
  maxCartLines: z.number().int().positive().default(50),
  cartRetentionDays: z.number().int().positive().default(30),
  minOrderPaise: paise.default('0'),
  maxOrderPaise: paise.default('50000000'),
  maxCodPaise: paise.default('500000'),
  deliveryFeeSlabs: feeSlabs.default([
    { maxOrderValuePaise: '20000', feePaise: '4000' },
    { maxOrderValuePaise: null, feePaise: '2000' },
  ]),
  freeDeliveryThresholdPaise: paise.default('59900'),
  handlingFeePaise: paise.default('500'),
  smallCartThresholdPaise: paise.default('19900'),
  smallCartFeePaise: paise.default('1500'),
  surgeFeePaise: paise.default('0'),
  paymentWindowSeconds: z.number().int().positive().max(86400).default(900),
  couponValidationAttemptsPerWindow: z.number().int().positive().default(10),
  refundDestinationPolicy: z
    .enum(['original', 'original_then_wallet', 'wallet'])
    .default('original_then_wallet'),
  promoSpendCapBps: z.number().int().min(0).max(10000).default(10000),
  walletLowBalanceThresholdPaise: paise.default('10000'),
  topupMinPaise: paise.default('10000'),
  topupMaxPaise: paise.default('1000000'),
  topupMonthlyCapPaise: paise.default('10000000'),
  codEligibility: z
    .object({ minCompletedPrepaidOrders: z.number().int().min(0).max(1000) })
    .strict()
    .default({ minCompletedPrepaidOrders: 0 }),
  feeTaxRules: z
    .array(
      z.object({
        appliesTo: z.enum(['DELIVERY', 'HANDLING', 'SMALL_CART', 'SURGE', 'ALL']),
        taxBps: z.number().int().min(0).max(10000),
        split: z.enum(['CGST_SGST', 'IGST']),
      }),
    )
    .max(20)
    .default([]),
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
  pickingSlaMinutes: z.number().int().min(1).max(1440).default(30),
  maxActivePickTasksPerPicker: z.number().int().min(1).max(50).default(5),
  handoverMaxAttempts: z.number().int().min(1).max(20).default(5),
  handoverLockoutSeconds: z.number().int().min(0).max(86400).default(300),
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
  dispatchTrigger: z.enum(['ON_PICK_START', 'ON_PACKED']).default('ON_PICK_START'),
  dispatchRadiusM: z.number().int().min(1).max(100000).default(3000),
  dispatchRadiusWideningStepsM: z
    .array(z.number().int().positive().max(100000))
    .min(1)
    .max(20)
    .default([1500, 3000, 5000]),
  dispatchMaxAttempts: z.number().int().min(1).max(100).default(5),
  dispatchAutoCancelMinutes: z.number().int().min(1).max(1440).default(30),
  dispatchNoRiderAlertAfterAttempts: z.number().int().min(1).max(100).default(2),
  offerTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
  offerDeclineCooldownSeconds: z.number().int().min(0).max(86400).default(300),
  riderMaxConcurrentTasks: z.number().int().min(1).max(20).default(3),
  riderStaleLocationSeconds: z.number().int().min(1).max(3600).default(120),
  riderHeartbeatStaleSeconds: z.number().int().min(1).max(3600).default(60),
  riderRedispatchMinutes: z.number().int().min(1).max(1440).default(10),
  riderInactivityOfflineMinutes: z.number().int().min(1).max(1440).default(30),
  riderMaxContinuousHours: z.number().min(1).max(24).default(12),
  cashInHandLimitPaise: paise.default('2000000'),
  earningsBasePaise: paise.default('3000'),
  earningsPerKmPaise: paise.default('800'),
  detentionFreeMinutes: z.number().int().min(0).max(1440).default(5),
  detentionPerMinutePaise: paise.default('100'),
  deliveryCodeMaxAttempts: z.number().int().min(1).max(20).default(5),
  deliveryFailureWaitSeconds: z.number().int().min(0).max(86400).default(300),
  deliveryFailureMinContactAttempts: z.number().int().min(1).max(20).default(2),
  deliveryCodeLockoutSeconds: z.number().int().min(1).max(86400).default(300),
  geofenceThresholdMetres: z.number().int().min(1).max(10000).default(300),
  dispatchScoreWeightsEta: z.number().nonnegative().max(1).default(0.6),
  dispatchScoreWeightsIdle: z.number().nonnegative().max(1).default(0.25),
  dispatchScoreWeightsAcceptance: z.number().nonnegative().max(1).default(0.15),
  locationRetentionDays: z.number().int().min(1).max(365).default(30),
  locationMinIntervalSeconds: z.number().positive().max(3600).default(15),
  locationMinDistanceMetres: z.number().positive().max(10000).default(50),
  locationMaxBatchPoints: z.number().int().min(1).max(500).default(50),
  locationMaxAccuracyMetres: z.number().positive().max(10000).default(100),
  locationMaxSpeedMps: z
    .number()
    .positive()
    .max(300)
    .default(250 / 3.6),
  etaRoadFactor: z.number().min(1).max(5).default(1.4),
  etaAvgSpeedKph: z.number().positive().max(150).default(20),
  etaPublishDeltaMinutes: z.number().positive().max(60).default(1),
  notificationQuietHoursStart: z.number().int().min(0).max(1439).default(1260),
  notificationQuietHoursEnd: z.number().int().min(0).max(1439).default(480),
  pickingWeightToleranceBps: z.number().int().min(0).max(10000).default(0),
  pickingDisconnectMinutes: z.number().int().min(1).max(1440).default(15),
  pickingShortRateAlertBps: z.number().int().min(1).max(10000).default(2500),
  referralIssuanceEnabled: z.boolean().default(true),
  // Positive paise within the wallet ledger's bigint range (amount_paise > 0).
  referralRewardPaise: paise
    .refine((v) => BigInt(v) >= 1n && BigInt(v) <= 9223372036854775807n, {
      message: 'referral reward must be a positive paise amount within wallet range',
    })
    .default('1000'),
  referralCreditExpiryMonths: z.number().int().min(1).max(12).default(1),
} satisfies { [K in ConfigKey]: z.ZodType<ConfigValues[K], unknown> };
const configSchema = z
  .object(definitions)
  .strict()
  .superRefine((v, ctx) => {
    if (v.subscriptionGenerationTime <= v.subscriptionCutoffTime)
      ctx.addIssue({
        code: 'custom',
        path: ['subscriptionGenerationTime'],
        message: 'generation must follow cutoff',
      });
    if (v.subscriptionGraceRetryTime >= v.subscriptionGraceDeadlineTime)
      ctx.addIssue({
        code: 'custom',
        path: ['subscriptionGraceDeadlineTime'],
        message: 'grace deadline must follow retry',
      });
    if (v.supportFirstResponseSlaHours > v.supportResolutionSlaHours)
      ctx.addIssue({
        code: 'custom',
        path: ['supportResolutionSlaHours'],
        message: 'resolution deadline must follow first response',
      });
    if (v.ratingEditHours > v.ratingWindowHours)
      ctx.addIssue({
        code: 'custom',
        path: ['ratingEditHours'],
        message: 'edit window cannot exceed rating window',
      });
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
    if (BigInt(v.minOrderPaise) > BigInt(v.maxOrderPaise))
      ctx.addIssue({ code: 'custom', path: ['minOrderPaise'], message: 'minimum exceeds maximum' });
    if (BigInt(v.topupMinPaise) > BigInt(v.topupMaxPaise))
      ctx.addIssue({ code: 'custom', path: ['topupMinPaise'], message: 'minimum exceeds maximum' });
    if (v.paymentWindowSeconds > v.inventoryReservationTtlSeconds)
      ctx.addIssue({
        code: 'custom',
        path: ['paymentWindowSeconds'],
        message: 'payment window must not outlive reservation TTL',
      });
    let previous: string | null = null;
    let nullSeen = false;
    for (const [index, slab] of v.deliveryFeeSlabs.entries()) {
      if (slab.maxOrderValuePaise === null) {
        if (index !== v.deliveryFeeSlabs.length - 1)
          ctx.addIssue({
            code: 'custom',
            path: ['deliveryFeeSlabs'],
            message: 'open-ended slab must be last',
          });
        nullSeen = true;
      } else if (previous !== null && BigInt(slab.maxOrderValuePaise) <= BigInt(previous)) {
        ctx.addIssue({
          code: 'custom',
          path: ['deliveryFeeSlabs'],
          message: 'slab ceilings must strictly ascend',
        });
      }
      if (slab.maxOrderValuePaise !== null) previous = slab.maxOrderValuePaise;
      if (nullSeen && slab.maxOrderValuePaise !== null)
        ctx.addIssue({
          code: 'custom',
          path: ['deliveryFeeSlabs'],
          message: 'slab after open-ended slab',
        });
    }
  });

/** DB versions are checked on every read, so invalidation loss cannot preserve stale policy. */
export class ConfigService implements AppConfig, AdminConfig {
  private readonly cache = new Map<
    ConfigKey,
    { version: string; value: ConfigValues[ConfigKey] }
  >();
  constructor(private readonly db: Database) {}
  async get<K extends ConfigKey>(key: K, tx?: TransactionContext): Promise<ConfigValues[K]> {
    return (await this.getMany([key], tx))[key];
  }
  async getMany<K extends ConfigKey>(
    keys: readonly K[],
    tx?: TransactionContext,
  ): Promise<Pick<ConfigValues, K>> {
    for (const key of keys) {
      if (!Object.hasOwn(definitions, key)) throw new Error('INVALID_CONFIG_KEY');
    }
    if (keys.length === 0) return {} as Pick<ConfigValues, K>;
    // In-transaction readers always take the shared side of the 701001 lock
    // before reading app_config, so they serialize with exclusive config
    // writers (update, setFlag, changeAddress, slot admin). Writers take the
    // exclusive lock first and readers never upgrade, so this cannot create an
    // upgrade deadlock; a writer that already holds the lock (same tx)
    // requests shared without self-conflict. Readers without a tx keep the
    // cached snapshot path and take no lock.
    if (tx) await sql`SELECT pg_advisory_xact_lock_shared(701001)`.execute(tx);
    const result = await sql<{
      key: K;
      value: Json;
      version: string;
    }>`SELECT key,value,version::text FROM app_config WHERE key IN (${sql.join(keys)})`.execute(
      tx ?? this.db,
    );
    const rows = new Map(result.rows.map((row) => [row.key, row]));
    const values = {} as Pick<ConfigValues, K>;
    for (const key of keys) {
      const row = rows.get(key);
      const version = row?.version ?? 'default';
      const cached = this.cache.get(key);
      const value =
        !tx && cached?.version === version
          ? (cached.value as ConfigValues[K])
          : (definitions[key].parse(row?.value) as ConfigValues[K]);
      if (!tx && cached?.version !== version) this.cache.set(key, { version, value });
      values[key] = structuredClone(value);
    }
    return values;
  }
  invalidate(): void {
    this.cache.clear();
  }
  async update(
    actorId: string,
    key: ConfigKey,
    value: unknown,
    expectedVersion?: string,
  ): Promise<void> {
    if (!Object.hasOwn(definitions, key)) throw new Error('INVALID_CONFIG_KEY');
    const parsed = definitions[key].parse(value);
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(701001)`.execute(tx);
      await assertSuperAdmin(actorId, tx);
      const values = await sql<{
        key: ConfigKey;
        value: Json;
        version: string;
      }>`SELECT key,value,version::text AS version FROM app_config`.execute(tx);
      assertVersion(expectedVersion, values.rows.find((row) => row.key === key)?.version ?? '0');
      const previous = values.rows.find((row) => row.key === key)?.value ?? null;
      const input: Record<string, unknown> = Object.fromEntries(
        values.rows.map((r) => [r.key, r.value]),
      );
      input[key] = parsed;
      const next = configSchema.parse(input);
      if (['subscriptionGraceDeadlineTime', 'subscriptionDispatchLeadMinutes'].includes(key)) {
        const schema = await sql<{
          present: string | null;
        }>`SELECT to_regclass('subscription_slots')::text AS present`.execute(tx);
        if (schema.rows[0]?.present) {
          const invalid = await sql`SELECT id FROM subscription_slots WHERE active AND
            (extract(epoch FROM start_time)/60 - ${next.subscriptionDispatchLeadMinutes}) <= extract(epoch FROM ${next.subscriptionGraceDeadlineTime}::time)/60 LIMIT 1`.execute(
            tx,
          );
          if (invalid.rows.length) throw new Error('INVALID_SLOT_TIMING');
        }
      }
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
  /**
   * Atomic multi-key write. Validates every per-key schema plus the combined
   * result before writing any row; a stale `expectedVersion` (or a duplicate
   * or unknown key) aborts the whole batch with no partial write.
   */
  async updateBatch(
    actorId: string,
    changes: readonly ConfigChange[],
  ): Promise<ConfigChangeResult[]> {
    if (!changes.length) throw new Error('INVALID_CONFIG_KEY');
    const keys = changes.map((change) => change.key);
    if (new Set(keys).size !== keys.length) throw new Error('DUPLICATE_CONFIG_KEY');
    for (const change of changes) {
      if (!Object.hasOwn(definitions, change.key)) throw new Error('INVALID_CONFIG_KEY');
    }
    const parsed = changes.map((change) => ({
      key: change.key,
      value: definitions[change.key].parse(change.value) as unknown,
      expectedVersion: change.expectedVersion,
    }));
    const result = await this.db
      .transaction()
      .execute(async (tx): Promise<ConfigChangeResult[]> => {
        await sql`SELECT pg_advisory_xact_lock(701001)`.execute(tx);
        await assertSuperAdmin(actorId, tx);
        const rows = await sql<{
          key: ConfigKey;
          value: Json;
          version: string;
        }>`SELECT key,value,version::text AS version FROM app_config`.execute(tx);
        const current = new Map(rows.rows.map((row) => [row.key, row]));
        for (const change of parsed) {
          assertVersion(change.expectedVersion, current.get(change.key)?.version ?? '0');
        }
        const input: Record<string, unknown> = Object.fromEntries(
          rows.rows.map((row) => [row.key, row.value]),
        );
        for (const change of parsed) input[change.key] = change.value;
        const next = configSchema.parse(input);
        if (
          parsed.some((change) =>
            ['subscriptionGraceDeadlineTime', 'subscriptionDispatchLeadMinutes'].includes(
              change.key,
            ),
          )
        ) {
          const schema = await sql<{
            present: string | null;
          }>`SELECT to_regclass('subscription_slots')::text AS present`.execute(tx);
          if (schema.rows[0]?.present) {
            const invalid = await sql`SELECT id FROM subscription_slots WHERE active AND
            (extract(epoch FROM start_time)/60 - ${next.subscriptionDispatchLeadMinutes}) <= extract(epoch FROM ${next.subscriptionGraceDeadlineTime}::time)/60 LIMIT 1`.execute(
              tx,
            );
            if (invalid.rows.length) throw new Error('INVALID_SLOT_TIMING');
          }
        }
        const out: ConfigChangeResult[] = [];
        for (const change of parsed) {
          const previous = current.get(change.key)?.value ?? null;
          const written = await sql<{
            version: string;
          }>`INSERT INTO app_config(key,value,updated_by) VALUES (${change.key},${JSON.stringify(change.value)}::jsonb,${actorId}::uuid)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=app_config.version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
        RETURNING version::text AS version`.execute(tx);
          const version =
            written.rows[0]?.version ??
            String(BigInt(current.get(change.key)?.version ?? '0') + 1n);
          await sql`INSERT INTO config_history(id,actor_id,key,old_value,new_value) VALUES (${uuidV7()}::uuid,${actorId}::uuid,${change.key},${JSON.stringify(previous)}::jsonb,${JSON.stringify(change.value)}::jsonb)`.execute(
            tx,
          );
          await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'CONFIG_CHANGED','app_config',${change.key},${JSON.stringify({ before: previous, after: change.value })}::jsonb)`.execute(
            tx,
          );
          out.push({ key: change.key, value: change.value, version });
        }
        return out;
      });
    this.invalidate();
    return result;
  }
  async snapshot(): Promise<{
    config: ConfigValues;
    flags: Record<FeatureFlagKey, boolean>;
    configRevisions: Record<string, string>;
    flagRevisions: Record<string, string>;
  }> {
    const config = await this.getMany(Object.keys(definitions) as ConfigKey[]);
    const configRows = await sql<{
      key: ConfigKey;
      version: string;
    }>`SELECT key,version::text AS version FROM app_config`.execute(this.db);
    const configRevisions = Object.fromEntries(
      (Object.keys(definitions) as ConfigKey[]).map((key) => [
        key,
        configRows.rows.find((row) => row.key === key)?.version ?? '0',
      ]),
    );
    const rows = await sql<{
      key: FeatureFlagKey;
      enabled: boolean;
      version: string;
    }>`SELECT key,enabled,version::text AS version FROM feature_flags`.execute(this.db);
    const flags = Object.fromEntries(
      FEATURE_FLAG_KEYS.map((key) => [
        key,
        rows.rows.find((row) => row.key === key)?.enabled ?? false,
      ]),
    ) as Record<FeatureFlagKey, boolean>;
    const flagRevisions = Object.fromEntries(
      FEATURE_FLAG_KEYS.map((key) => [
        key,
        rows.rows.find((row) => row.key === key)?.version ?? '0',
      ]),
    );
    return { config, flags, configRevisions, flagRevisions };
  }
  async flag(key: FeatureFlagKey, tx?: TransactionContext): Promise<boolean> {
    if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) throw new Error('INVALID_FLAG');
    const result = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM feature_flags WHERE key=${key}`.execute(tx ?? this.db);
    return result.rows[0]?.enabled === true;
  }
  async setFlag(
    actorId: string,
    key: FeatureFlagKey,
    enabled: boolean,
    expectedVersion?: string,
  ): Promise<void> {
    if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key) || typeof enabled !== 'boolean')
      throw new Error('INVALID_FLAG');
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(701001)`.execute(tx);
      await assertSuperAdmin(actorId, tx);
      // Retired subscriptions can never be re-enabled; the wallet flag no
      // longer depends on the retired flag (plan3 section 7).
      if (key === 'subscriptions_enabled' && enabled) throw new Error('SUBSCRIPTIONS_RETIRED');
      const old = await sql<{
        enabled: boolean;
        version: string;
      }>`SELECT enabled,version::text AS version FROM feature_flags WHERE key=${key}`.execute(tx);
      assertVersion(expectedVersion, old.rows[0]?.version ?? '0');
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
