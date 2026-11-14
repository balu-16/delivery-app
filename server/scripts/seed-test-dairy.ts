import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { Kysely, PostgresDialect } from 'kysely';
import { Client, Pool, type QueryResult, type QueryResultRow } from 'pg';
import { createS3Client } from '../src/adapters/storage/s3-client.js';
import { uuidV7 } from '../src/common/ids/ids.js';
import { ConfigService as RuntimeConfig } from '../src/config/config.service.js';
import { readEnv } from '../src/config/env.schema.js';
import { ConfigService } from '../src/modules/app-config/infrastructure/config-service.js';
import { PostgresCatalogAdmin } from '../src/modules/catalog/infrastructure/catalog-admin.js';
import { MakerChecker } from '../src/modules/compliance/infrastructure/maker-checker.js';
import { DatabaseIdentityAccess } from '../src/modules/identity/infrastructure/identity-access.js';
import { PostgresInventoryManagement } from '../src/modules/inventory/infrastructure/management.js';
import { CatalogMediaService } from '../src/modules/media/infrastructure/catalog-media.js';
import { S3Storage } from '../src/modules/media/infrastructure/s3-storage.js';
import { PostgresStoreAdministration } from '../src/modules/stores/infrastructure/store-administration.js';
import {
  databaseIamRegion,
  postgresConnectionConfig,
  type PlatformSchema,
} from '../src/platform/database/database.js';
import {
  assertTestTarget,
  mapLimited,
  TEST_CATEGORY,
  TEST_CLUSTER,
  TEST_DESCRIPTION,
  TEST_PRODUCTS,
  TEST_REGION,
  TEST_STORES,
} from './seed-test-dairy-data.js';

const apply = process.argv.slice(2).includes('--apply');
if (process.argv.slice(2).some((argument) => argument !== '--apply'))
  throw new Error('INVALID_ARGUMENT');
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
  const clusterEndpoint = aws([
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
    clusterEndpoint,
  });

  // All images already belong to the project and are used only for labelled test products.
  const images = new Map<string, Buffer>();
  for (const product of TEST_PRODUCTS) {
    if (images.has(product.image)) continue;
    const data = await readFile(
      fileURLToPath(new URL(`../../milk_app/assets/images/${product.image}`, import.meta.url)),
    );
    if (data.length < 100 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      throw new Error('INVALID_TEST_IMAGE');
    images.set(product.image, data);
  }

  const connection = postgresConnectionConfig(env.DATABASE_URL, databaseIamRegion(process.env));
  const client = new Client({
    ...connection,
    application_name: 'dairydirect-test-dairy-lock',
    connectionTimeoutMillis: 30000,
    query_timeout: 45000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
  let previousQuery = Promise.resolve();
  async function query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    const prior = previousQuery;
    let release!: () => void;
    previousQuery = new Promise<void>((resolve) => {
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
    application_name: 'dairydirect-test-dairy',
    max: 6,
    connectionTimeoutMillis: 30000,
    statement_timeout: 30000,
    query_timeout: 45000,
    idle_in_transaction_session_timeout: 90000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
  pool.on('error', () =>
    process.stderr.write('A test setup database connection was interrupted.\n'),
  );
  const db = new Kysely<PlatformSchema>({ dialect: new PostgresDialect({ pool }) });
  const s3 = createS3Client(new RuntimeConfig(env));
  let locked = false;
  try {
    await client.connect();
    const lock = await query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('dairydirect-test-dairy-v1')) AS ok",
    );
    if (!lock.rows[0]?.ok) throw new Error('TEST_SETUP_ALREADY_RUNNING');
    locked = true;
    const fixtures = await query<{
      id: string;
      cognito_sub: string;
      normalized_email: string;
      roles: string[];
    }>(
      `SELECT u.id::text,u.cognito_sub,u.normalized_email,array_agg(r.role) AS roles FROM users u JOIN user_roles r ON r.user_id=u.id
       WHERE u.pool='WORKFORCE' AND u.status='ACTIVE' AND u.cognito_sub=ANY($1::text[]) GROUP BY u.id`,
      [['super-admin-1', 'manager']],
    );
    const admin = fixtures.rows.find((row) => row.cognito_sub === 'super-admin-1');
    const manager = fixtures.rows.find((row) => row.cognito_sub === 'manager');
    if (
      !admin ||
      admin.normalized_email !== 'super-admin-1@example.test' ||
      !admin.roles.includes('SUPER_ADMIN') ||
      !manager ||
      manager.normalized_email !== 'manager@example.test' ||
      !manager.roles.includes('STORE_MANAGER')
    )
      throw new Error('EXPECTED_DEMO_IDENTITIES_MISSING');
    const stores = await query<{
      id: string;
      name: string;
      city: string;
      status: string;
      active_zones: string;
    }>(
      `SELECT s.id::text,s.name,c.name AS city,s.status,count(z.id) FILTER (WHERE z.active)::text AS active_zones
       FROM stores s JOIN cities c ON c.id=s.city_id LEFT JOIN zones z ON z.store_id=s.id
       WHERE s.id=ANY($1::uuid[]) GROUP BY s.id,c.name`,
      [TEST_STORES.map((store) => store.id)],
    );
    for (const expected of TEST_STORES) {
      const found = stores.rows.find((store) => store.id === expected.id);
      if (
        !found ||
        found.name !== expected.name ||
        found.city !== 'Bengaluru' ||
        found.status !== 'ONLINE' ||
        found.active_zones === '0'
      )
        throw new Error('EXPECTED_DEMO_STORES_MISSING');
    }
    const categories = await query<{ id: string }>(
      'SELECT id::text FROM catalog_categories WHERE name=$1 AND deleted_at IS NULL',
      [TEST_CATEGORY],
    );
    if (categories.rows.length > 1) throw new Error('TEST_CATEGORY_CONFLICT');
    const names = await query<{ name: string; category_id: string }>(
      'SELECT name,category_id::text FROM catalog_products WHERE name=ANY($1::text[]) AND deleted_at IS NULL',
      [TEST_PRODUCTS.map((item) => item.name)],
    );
    if (
      names.rows.some((row) => row.category_id !== categories.rows[0]?.id) ||
      new Set(names.rows.map((row) => row.name)).size !== names.rows.length
    )
      throw new Error('TEST_PRODUCT_CONFLICT');
    process.stdout.write(
      `Verified AWS development account, database, ${stores.rows.length} Bengaluru stores and ${images.size} image files.\n`,
    );
    if (!apply) {
      process.stdout.write(
        'Dry run only. Pass --apply to create the test products and enable cash on delivery and wallet.\n',
      );
      return;
    }

    const identity = new DatabaseIdentityAccess(db);
    const config = new ConfigService(db);
    const storeAdmin = new PostgresStoreAdministration(db, identity);
    const inventory = new PostgresInventoryManagement(db, identity);
    const catalog = new PostgresCatalogAdmin(db, identity, config, {
      create: (actions) => new MakerChecker(db, actions),
    });
    const storage = new S3Storage(s3, env.S3_MEDIA_BUCKET, env.S3_PRIVATE_BUCKET);
    const media = new CatalogMediaService(
      db,
      identity,
      storage,
      config,
      env.PRIVATE_UPLOAD_URL_TTL_SECONDS,
    );
    const temporary: { storeId: string; runId: string }[] = [];

    async function recordAssignment(action: string, storeId: string, runId: string): Promise<void> {
      await query(
        `INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES($1,$2,$3,'store',$4,$5::jsonb)`,
        [uuidV7(), admin!.id, action, storeId, JSON.stringify({ runId, managerId: manager!.id })],
      );
    }
    async function releaseAssignment(storeId: string, runId: string): Promise<void> {
      await storeAdmin.assign(admin!.id, storeId, manager!.id, 'STORE_MANAGER', false);
      await recordAssignment('TEST_DAIRY_GRANT_RELEASED', storeId, runId);
    }
    stage = 'recovering temporary demo assignments';
    const pending = await query<{ store_id: string; run_id: string }>(
      `SELECT i.subject_id AS store_id,i.details->>'runId' AS run_id FROM audit_log i
       WHERE i.action='TEST_DAIRY_GRANT_INTENT' AND i.actor_id=$1 AND i.subject_id=ANY($2::text[])
       AND i.details->>'managerId'=$3 AND NOT EXISTS (SELECT 1 FROM audit_log d
         WHERE d.action='TEST_DAIRY_GRANT_RELEASED' AND d.actor_id=i.actor_id AND d.subject_id=i.subject_id
           AND d.details->>'runId'=i.details->>'runId')`,
      [admin.id, TEST_STORES.map((store) => store.id), manager.id],
    );
    for (const intent of pending.rows) await releaseAssignment(intent.store_id, intent.run_id);

    let taskFailure: unknown;
    let cleanupFailed = false;
    try {
      stage = 'catalog products and images';
      const categoryId =
        categories.rows[0]?.id ?? (await catalog.saveNamed(admin.id, 'categories', TEST_CATEGORY));
      const items = await mapLimited(TEST_PRODUCTS, async (product) => {
        const existing = await query<{ id: string; category_id: string }>(
          'SELECT id::text,category_id::text FROM catalog_products WHERE name=$1 AND deleted_at IS NULL',
          [product.name],
        );
        if (
          existing.rows.length > 1 ||
          (existing.rows[0] && existing.rows[0].category_id !== categoryId)
        )
          throw new Error('TEST_PRODUCT_CONFLICT');
        const productId =
          existing.rows[0]?.id ??
          (await catalog.saveProduct(admin.id, {
            categoryId,
            name: product.name,
            description: TEST_DESCRIPTION,
            hsnCode: product.hsn,
            gstRateBps: 0,
            perishable: true,
            expiryTracking: true,
          }));
        const variant = await query<{ id: string; product_id: string }>(
          'SELECT id::text,product_id::text FROM catalog_variants WHERE sku=$1 AND deleted_at IS NULL',
          [product.sku],
        );
        if (variant.rows[0] && variant.rows[0].product_id !== productId)
          throw new Error('TEST_SKU_CONFLICT');
        const variantId =
          variant.rows[0]?.id ??
          (await catalog.saveVariant(admin.id, {
            productId,
            name: product.pack,
            sku: product.sku,
            baseUnit: 'PIECE',
          }));
        const existingImage = await query<{ id: string; object_key: string }>(
          `SELECT m.id::text,m.object_key FROM catalog_product_images i JOIN catalog_media m ON m.id=i.media_id
           WHERE i.product_id=$1 AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE' ORDER BY i.position,m.id LIMIT 1`,
          [productId],
        );
        let mediaId = existingImage.rows[0]?.id;
        if (existingImage.rows[0]) {
          if (!existingImage.rows[0].object_key.startsWith('public/'))
            throw new Error('TEST_IMAGE_CONFLICT');
          await s3.send(
            new HeadObjectCommand({
              Bucket: env.S3_MEDIA_BUCKET,
              Key: existingImage.rows[0].object_key,
            }),
          );
        } else {
          const data = images.get(product.image)!;
          const target = await media.target(admin.id, 'PRODUCT_IMAGE', 'image/png', data.length);
          const form = new FormData();
          for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
          form.append(
            'file',
            new Blob([Uint8Array.from(data)], { type: 'image/png' }),
            product.image,
          );
          const response = await fetch(target.url, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(60000),
          });
          if (!response.ok) throw new Error(`S3_UPLOAD_${response.status}`);
          await media.register(admin.id, target.mediaId, productId);
          mediaId = target.mediaId;
        }
        if (!mediaId) throw new Error('TEST_IMAGE_MISSING');
        for (const store of TEST_STORES) {
          const assortment = await query(
            'SELECT 1 FROM store_inventory WHERE store_id=$1 AND variant_id=$2',
            [store.id, variantId],
          );
          if (!assortment.rowCount) await catalog.setAssortment(admin.id, store.id, variantId);
          const price = await query(
            'SELECT 1 FROM catalog_prices WHERE store_id=$1 AND variant_id=$2 AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())',
            [store.id, variantId],
          );
          if (!price.rowCount) {
            const result = await catalog.setPrice(admin.id, {
              storeId: store.id,
              variantId,
              sellingPaise: product.paise,
              mrpPaise: product.paise,
            });
            if (result.approvalId) throw new Error('TEST_PRICE_APPROVAL_REQUIRED');
          }
        }
        process.stdout.write(`Prepared ${product.name}.\n`);
        return { sku: product.sku, productId, variantId, mediaId };
      });

      stage = 'receipt-backed test stock';
      for (const store of TEST_STORES) {
        const assigned = await query(
          'SELECT 1 FROM store_staff WHERE user_id=$1 AND store_id=$2 AND role=$3',
          [manager.id, store.id, 'STORE_MANAGER'],
        );
        if (!assigned.rowCount) {
          const runId = uuidV7();
          await recordAssignment('TEST_DAIRY_GRANT_INTENT', store.id, runId);
          temporary.push({ storeId: store.id, runId });
          await storeAdmin.assign(admin.id, store.id, manager.id, 'STORE_MANAGER', true);
        }
        await mapLimited(items, async (item) => {
          const reference = `test-dairy-v1:${item.sku}`;
          const operationReference = `receipt:${store.id}:${manager.id}:${reference}`;
          const receipt = await query<{ kind: string; amount: string; variant_id: string }>(
            `SELECT o.kind,l.on_hand_delta::text AS amount,l.variant_id::text FROM inventory_operations o
             JOIN inventory_ledger l ON l.reference=o.reference WHERE o.reference=$1`,
            [operationReference],
          );
          if (receipt.rows.length) {
            if (
              receipt.rows.length !== 1 ||
              receipt.rows[0]?.kind !== 'RECEIPT' ||
              receipt.rows[0]?.amount !== '20' ||
              receipt.rows[0]?.variant_id !== item.variantId
            )
              throw new Error('TEST_RECEIPT_CONFLICT');
            return;
          }
          const batch = await query(
            'SELECT 1 FROM inventory_batches WHERE store_id=$1 AND variant_id=$2 AND batch_code=$3',
            [store.id, item.variantId, 'TEST-DAIRY-OPENING'],
          );
          if (batch.rowCount) throw new Error('TEST_BATCH_CONFLICT');
          await inventory.receive(manager.id, {
            storeId: store.id,
            variantId: item.variantId,
            batchCode: 'TEST-DAIRY-OPENING',
            quantity: '20',
            expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
            reference,
          });
        });
        process.stdout.write(`Stocked test items for ${store.name}.\n`);
      }
      stage = 'publishing test products';
      await mapLimited(items, async (item) => {
        const state = await query<{ published: boolean }>(
          'SELECT published FROM catalog_products WHERE id=$1',
          [item.productId],
        );
        if (!state.rows[0]?.published) await catalog.publish(admin.id, item.productId, true);
      });
      stage = 'enabling customer payment options';
      if (!(await config.flag('wallet_enabled')))
        await config.setFlag(admin.id, 'wallet_enabled', true);
      if (!(await config.flag('cod_enabled'))) await config.setFlag(admin.id, 'cod_enabled', true);
      for (const store of TEST_STORES) {
        const state = await query<{ accepts_cod: boolean; version: string }>(
          'SELECT accepts_cod,version::text FROM stores WHERE id=$1',
          [store.id],
        );
        const current = state.rows[0];
        if (!current) throw new Error('TEST_STORE_MISSING');
        if (!current.accepts_cod)
          await storeAdmin.setCod(admin.id, store.id, true, current.version);
      }
      process.stdout.write('Published 10 test products and enabled wallet and cash on delivery.\n');
    } catch (error) {
      taskFailure = error;
    } finally {
      const previousStage = stage;
      stage = 'restoring temporary demo assignments';
      for (const assignment of temporary.reverse()) {
        try {
          await releaseAssignment(assignment.storeId, assignment.runId);
        } catch {
          cleanupFailed = true;
        }
      }
      stage = previousStage;
    }
    if (cleanupFailed) {
      stage = 'restoring temporary demo assignments';
      throw new Error('TEST_ASSIGNMENT_CLEANUP_FAILED');
    }
    if (taskFailure) throw taskFailure;
  } finally {
    if (locked)
      await query("SELECT pg_advisory_unlock(hashtext('dairydirect-test-dairy-v1'))").catch(
        () => undefined,
      );
    await client.end().catch(() => undefined);
    await db.destroy();
    s3.destroy();
  }
}

void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.message)
      ? error.message
      : 'REQUEST_FAILED';
  process.stderr.write(
    `Test catalog setup stopped during ${stage} (${code}). No credentials or file contents are logged.\n`,
  );
  process.exitCode = 1;
});
