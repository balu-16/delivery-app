/** Provision only the explicitly designated AWS development database. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import { Client, Pool, type QueryResult, type QueryResultRow } from 'pg';
import { uuidV7 } from '../src/common/ids/ids.js';
import { readEnv } from '../src/config/env.schema.js';
import { ConfigService } from '../src/modules/app-config/infrastructure/config-service.js';
import { PostgresCatalogAdmin } from '../src/modules/catalog/infrastructure/catalog-admin.js';
import { MakerChecker } from '../src/modules/compliance/infrastructure/maker-checker.js';
import { DatabaseIdentityAccess } from '../src/modules/identity/infrastructure/identity-access.js';
import { PostgresInventoryManagement } from '../src/modules/inventory/infrastructure/management.js';
import { PostgresStoreAdministration } from '../src/modules/stores/infrastructure/store-administration.js';
import { PostgresStoreManagement } from '../src/modules/stores/infrastructure/store-status.js';
import { PostgresZones } from '../src/modules/stores/infrastructure/postgres-zones.js';
import {
  databaseIamRegion,
  postgresConnectionConfig,
  type PlatformSchema,
} from '../src/platform/database/database.js';
import {
  assertTestTarget,
  mapLimited,
  TEST_CLUSTER,
  TEST_PRODUCTS,
  TEST_REGION,
} from './seed-test-dairy-data.js';

const apply = process.argv.slice(2).includes('--apply');
if (process.argv.slice(2).some((value) => value !== '--apply')) throw new Error('INVALID_ARGUMENT');
const legalId = '01800000-0000-7000-8000-000000000001';
const areas = [
  { key: 'vijayawada', name: 'Vijayawada', lat: 16.50547, lng: 80.64823 },
  { key: 'guntur', name: 'Guntur', lat: 16.30651, lng: 80.4361 },
] as const;
const mrp: Record<string, string> = { 'DD-TEST-001': '4000', 'DD-TEST-007': '18000' };
let stage = 'preflight';

function aws(args: string[]): string {
  return execFileSync('aws', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  }).trim();
}

async function main(): Promise<void> {
  const env = readEnv(process.env);
  const account = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  const endpoint = aws([
    'rds',
    'describe-db-clusters',
    '--db-cluster-identifier',
    TEST_CLUSTER,
    '--region',
    TEST_REGION,
    '--query',
    'DBClusters[0].Endpoint',
    '--output',
    'text',
  ]);
  assertTestTarget({
    account,
    region: env.AWS_REGION,
    nodeEnv: env.NODE_ENV,
    auth: env.AUTH_PROVIDER,
    databaseAuth: env.DATABASE_AUTH,
    storage: env.STORAGE_PROVIDER,
    databaseUrl: env.DATABASE_URL,
    clusterEndpoint: endpoint,
  });
  const geometries = new Map<string, object>();
  for (const area of areas) {
    const path = fileURLToPath(new URL(`./fixtures/${area.key}-municipal.json`, import.meta.url));
    const data = JSON.parse(await readFile(path, 'utf8')) as {
      geometry?: { type?: string };
      source?: string;
    };
    if (
      data.geometry?.type !== 'Polygon' ||
      !data.source?.startsWith('https://www.openstreetmap.org/relation/')
    )
      throw new Error('INVALID_BOUNDARY_FIXTURE');
    geometries.set(area.key, data.geometry);
  }
  const connection = postgresConnectionConfig(env.DATABASE_URL, databaseIamRegion(process.env));
  const client = new Client({
    ...connection,
    application_name: 'dairydirect-test-city-lock',
    connectionTimeoutMillis: 30000,
    query_timeout: 45000,
    keepAlive: true,
  });
  let previous = Promise.resolve();
  async function query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    const prior = previous;
    let release!: () => void;
    previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await client.query<Row>(text, values);
    } finally {
      release();
    }
  }
  const pool = new Pool({
    ...connection,
    application_name: 'dairydirect-test-city-seed',
    max: 6,
    connectionTimeoutMillis: 30000,
    statement_timeout: 30000,
    query_timeout: 45000,
    keepAlive: true,
  });
  pool.on('error', () =>
    process.stderr.write('A test setup database connection was interrupted.\n'),
  );
  const db = new Kysely<PlatformSchema>({ dialect: new PostgresDialect({ pool }) });
  let locked = false;
  try {
    await client.connect();
    if (
      !(
        await query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('dairydirect-test-city-v1')) AS ok",
        )
      ).rows[0]?.ok
    )
      throw new Error('TEST_SETUP_ALREADY_RUNNING');
    locked = true;
    const actors = await query<{
      id: string;
      cognito_sub: string;
      normalized_email: string;
      roles: string[];
    }>(
      `SELECT u.id::text,u.cognito_sub,u.normalized_email,array_agg(r.role) AS roles FROM users u JOIN user_roles r ON r.user_id=u.id
       WHERE u.pool='WORKFORCE' AND u.status='ACTIVE' AND u.cognito_sub=ANY($1::text[]) GROUP BY u.id`,
      [['super-admin-1', 'manager']],
    );
    const admin = actors.rows.find((actor) => actor.cognito_sub === 'super-admin-1');
    const manager = actors.rows.find((actor) => actor.cognito_sub === 'manager');
    if (
      !admin ||
      admin.normalized_email !== 'super-admin-1@example.test' ||
      !admin.roles.includes('SUPER_ADMIN') ||
      !manager ||
      manager.normalized_email !== 'manager@example.test' ||
      !manager.roles.includes('STORE_MANAGER')
    )
      throw new Error('EXPECTED_DEMO_IDENTITIES_MISSING');
    const entity = await query<{ name: string }>('SELECT name FROM legal_entities WHERE id=$1', [
      legalId,
    ]);
    if (entity.rows[0]?.name !== 'Local Delivery') throw new Error('EXPECTED_DEMO_ENTITY_MISSING');
    const products = await query<{
      sku: string;
      variant_id: string;
      product_id: string;
      images: string;
    }>(
      `SELECT v.sku,v.id::text AS variant_id,p.id::text AS product_id,
        (SELECT count(*)::text FROM catalog_product_images i JOIN catalog_media m ON m.id=i.media_id
          WHERE i.product_id=p.id AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE' AND m.object_key LIKE 'public/%') AS images
       FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id
       JOIN catalog_categories c ON c.id=p.category_id AND c.name='Test Dairy' AND c.deleted_at IS NULL
       WHERE v.sku=ANY($1::text[]) AND v.deleted_at IS NULL AND p.published AND p.deleted_at IS NULL`,
      [TEST_PRODUCTS.map((p) => p.sku)],
    );
    if (
      products.rows.length !== TEST_PRODUCTS.length ||
      products.rows.some((row) => row.images === '0')
    )
      throw new Error('EXPECTED_TEST_PRODUCTS_MISSING');
    for (const area of areas) {
      const geometry = JSON.stringify(geometries.get(area.key));
      const check = await query<{ valid: boolean }>(
        `SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AND GeometryType(g)='POLYGON'
        AND ST_Covers(g,ST_SetSRID(ST_MakePoint($2,$3),4326)) AS valid
        FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS g) x`,
        [geometry, area.lng, area.lat],
      );
      if (!check.rows[0]?.valid) throw new Error('INVALID_BOUNDARY_FIXTURE');
    }
    process.stdout.write(
      'Verified the AWS development target, demo identities, 10 published products and both municipal boundaries.\n',
    );
    if (!apply) {
      process.stdout.write('Dry run only. Pass --apply to create the two test stores.\n');
      return;
    }

    const identity = new DatabaseIdentityAccess(db);
    const config = new ConfigService(db);
    const adminStores = new PostgresStoreAdministration(db, identity);
    const status = new PostgresStoreManagement(db, identity);
    const zones = new PostgresZones(db, identity);
    const inventory = new PostgresInventoryManagement(db, identity);
    const catalog = new PostgresCatalogAdmin(db, identity, config, {
      create: (actions) => new MakerChecker(db, actions),
    });
    const temporary: { storeId: string; runId: string }[] = [];
    async function record(action: string, storeId: string, runId: string) {
      await query(
        `INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES($1,$2,$3,'store',$4,$5::jsonb)`,
        [uuidV7(), admin!.id, action, storeId, JSON.stringify({ runId, managerId: manager!.id })],
      );
    }
    async function release(storeId: string, runId: string) {
      await adminStores.assign(admin!.id, storeId, manager!.id, 'STORE_MANAGER', false);
      await record('TEST_CITY_GRANT_RELEASED', storeId, runId);
    }
    // Recover only temporary grants previously made by this exact setup.
    const pending = await query<{ store_id: string; run_id: string }>(
      `SELECT i.subject_id AS store_id,i.details->>'runId' AS run_id FROM audit_log i
      WHERE i.action='TEST_CITY_GRANT_INTENT' AND i.actor_id=$1 AND i.details->>'managerId'=$2
      AND NOT EXISTS (SELECT 1 FROM audit_log d WHERE d.action='TEST_CITY_GRANT_RELEASED' AND d.actor_id=i.actor_id
        AND d.subject_id=i.subject_id AND d.details->>'runId'=i.details->>'runId')`,
      [admin.id, manager.id],
    );
    for (const grant of pending.rows) await release(grant.store_id, grant.run_id);

    let failure: unknown,
      cleanupFailed = false;
    try {
      for (const area of areas) {
        stage = `setting up ${area.name}`;
        const name = `${area.name} test`;
        const geo = JSON.stringify(geometries.get(area.key));
        const cities = await query<{ id: string; same: boolean }>(
          `SELECT id::text,ST_Equals(bounds,ST_SetSRID(ST_GeomFromGeoJSON($2),4326)) AS same FROM cities WHERE name=$1`,
          [name, geo],
        );
        if (cities.rows.length > 1 || (cities.rows[0] && !cities.rows[0].same))
          throw new Error('TEST_CITY_CONFLICT');
        const cityId =
          cities.rows[0]?.id ??
          (await adminStores.saveCity(admin.id, name, geometries.get(area.key)!));
        const stores = await query<{
          id: string;
          city_id: string;
          legal_entity_id: string;
          status: string;
          accepts_cod: boolean;
          version: string;
          same: boolean;
        }>(
          `SELECT id::text,city_id::text,legal_entity_id::text,status,accepts_cod,version::text,
            ST_DWithin(location,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,1) AS same FROM stores WHERE name=$1`,
          [name, area.lng, area.lat],
        );
        if (
          stores.rows.length > 1 ||
          (stores.rows[0] &&
            (stores.rows[0].city_id !== cityId ||
              stores.rows[0].legal_entity_id !== legalId ||
              !stores.rows[0].same))
        )
          throw new Error('TEST_STORE_CONFLICT');
        const storeId =
          stores.rows[0]?.id ??
          (await adminStores.saveStore(admin.id, {
            legalEntityId: legalId,
            cityId,
            name,
            lat: area.lat,
            lng: area.lng,
            hourlyCapacity: 100,
            lastOrderBufferMinutes: 0,
          }));
        const complete = await query(
          'SELECT 1 FROM audit_log WHERE actor_id=$1 AND action=$2 AND subject_id=$3 LIMIT 1',
          [admin.id, 'TEST_CITY_SETUP_COMPLETED', storeId],
        );
        if (complete.rowCount) {
          process.stdout.write(`${area.name} test store already prepared: ${storeId}\n`);
          continue;
        }
        const existingZone = await query<{ same: boolean }>(
          `SELECT ST_Equals(polygon,ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2),4326))) AS same
          FROM zones WHERE store_id=$1 AND name=$3 AND active`,
          [storeId, geo, `${name} zone`],
        );
        if (existingZone.rows.length > 1 || (existingZone.rows[0] && !existingZone.rows[0].same))
          throw new Error('TEST_ZONE_CONFLICT');
        if (!existingZone.rows.length)
          await zones.create(
            {
              storeId,
              name: `${name} zone`,
              geometry: geometries.get(area.key)!,
              priority: 1,
              active: true,
            },
            { minM2: await config.get('zoneMinAreaM2'), maxM2: await config.get('zoneMaxAreaM2') },
            admin.id,
          );
        const hours = await query('SELECT 1 FROM store_hours WHERE store_id=$1 LIMIT 1', [storeId]);
        if (!hours.rowCount)
          await adminStores.hours(
            admin.id,
            storeId,
            Array.from({ length: 7 }, (_, weekday) => ({
              weekday,
              startMinute: 0,
              endMinute: 1440,
            })),
          );
        const assigned = await query(
          'SELECT 1 FROM store_staff WHERE user_id=$1 AND store_id=$2 AND role=$3',
          [manager.id, storeId, 'STORE_MANAGER'],
        );
        if (!assigned.rowCount) {
          const runId = uuidV7();
          await record('TEST_CITY_GRANT_INTENT', storeId, runId);
          temporary.push({ storeId, runId });
          await adminStores.assign(admin.id, storeId, manager.id, 'STORE_MANAGER', true);
        }
        await mapLimited(TEST_PRODUCTS, async (product) => {
          const row = products.rows.find((item) => item.sku === product.sku)!;
          if (
            !(
              await query('SELECT 1 FROM store_inventory WHERE store_id=$1 AND variant_id=$2', [
                storeId,
                row.variant_id,
              ])
            ).rowCount
          )
            await catalog.setAssortment(admin.id, storeId, row.variant_id);
          if (
            !(
              await query(
                'SELECT 1 FROM catalog_prices WHERE store_id=$1 AND variant_id=$2 AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())',
                [storeId, row.variant_id],
              )
            ).rowCount
          ) {
            const priced = await catalog.setPrice(admin.id, {
              storeId,
              variantId: row.variant_id,
              sellingPaise: product.paise,
              mrpPaise: mrp[product.sku] ?? product.paise,
            });
            if (priced.approvalId) throw new Error('TEST_PRICE_APPROVAL_REQUIRED');
          }
          const reference = `test-city-dairy-v1:${product.sku}`;
          const operationReference = `receipt:${storeId}:${manager.id}:${reference}`;
          const receipt = await query<{ kind: string; amount: string; variant_id: string }>(
            `SELECT o.kind,l.on_hand_delta::text AS amount,l.variant_id::text
            FROM inventory_operations o JOIN inventory_ledger l ON l.reference=o.reference WHERE o.reference=$1`,
            [operationReference],
          );
          if (receipt.rows.length) {
            if (
              receipt.rows.length !== 1 ||
              receipt.rows[0]?.kind !== 'RECEIPT' ||
              receipt.rows[0]?.amount !== '20' ||
              receipt.rows[0]?.variant_id !== row.variant_id
            )
              throw new Error('TEST_RECEIPT_CONFLICT');
          } else {
            if (
              (
                await query(
                  'SELECT 1 FROM inventory_batches WHERE store_id=$1 AND variant_id=$2 AND batch_code=$3',
                  [storeId, row.variant_id, 'TEST-CITY-OPENING'],
                )
              ).rowCount
            )
              throw new Error('TEST_BATCH_CONFLICT');
            await inventory.receive(manager.id, {
              storeId,
              variantId: row.variant_id,
              batchCode: 'TEST-CITY-OPENING',
              quantity: '20',
              expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
              reference,
            });
          }
        });
        const current = (
          await query<{ accepts_cod: boolean; version: string; status: string }>(
            'SELECT accepts_cod,version::text,status FROM stores WHERE id=$1',
            [storeId],
          )
        ).rows[0];
        if (!current) throw new Error('TEST_STORE_MISSING');
        if (!current.accepts_cod)
          await adminStores.setCod(admin.id, storeId, true, current.version);
        if (current.status === 'OFFLINE')
          await status.setStatus({
            storeId,
            actorId: admin.id,
            status: 'ONLINE',
            admin: true,
            correlationId: uuidV7(),
          });
        else if (current.status !== 'ONLINE') throw new Error('TEST_STORE_PAUSED');
        await record('TEST_CITY_SETUP_COMPLETED', storeId, uuidV7());
        process.stdout.write(`${area.name} test store prepared: ${storeId}\n`);
      }
    } catch (error) {
      failure = error;
    } finally {
      for (const grant of temporary.reverse()) {
        try {
          await release(grant.storeId, grant.runId);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) throw new Error('TEST_ASSIGNMENT_CLEANUP_FAILED');
    if (failure) throw failure;
  } finally {
    if (locked)
      await query("SELECT pg_advisory_unlock(hashtext('dairydirect-test-city-v1'))").catch(
        () => undefined,
      );
    await client.end().catch(() => undefined);
    await db.destroy();
  }
}
void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.message)
      ? error.message
      : 'REQUEST_FAILED';
  process.stderr.write(
    `Test city setup stopped during ${stage} (${code}). No credentials or private data are logged.\n`,
  );
  process.exitCode = 1;
});
