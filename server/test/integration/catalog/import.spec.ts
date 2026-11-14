import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { ImportService } from '../../../src/modules/catalog/infrastructure/import-service.js';
import { CatalogImportWorker } from '../../../src/modules/catalog/infrastructure/import-worker.js';
import type { StoragePort } from '../../../src/modules/media/contracts/storage.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices, db: DatabaseHandle, imports: ImportService, worker: CatalogImportWorker;
const checker = uuidV7(),
  owner = uuidV7(),
  category = uuidV7(),
  city = uuidV7(),
  entity = uuidV7(),
  store = uuidV7(),
  media = uuidV7();
let file: Buffer;
const values = {
  catalogImportMaxBytes: 100000,
  catalogImportMaxRows: 100,
  catalogImportBatchSize: 1,
  catalogAllowedGstBps: [500],
  catalogPriceApprovalCount: 20,
  catalogPriceApprovalPercent: 20,
};
const config = {
  get: async <K extends ConfigKey>(k: K) => values[k as keyof typeof values] as ConfigValues[K],
} satisfies AppConfig;
const storage = { open: async () => Readable.from([file]) } as unknown as StoragePort;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${owner}::uuid,'WORKFORCE','import-admin','import@example.com','admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${owner}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${checker}::uuid,'WORKFORCE','checker','checker@example.com','checker')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${checker}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',1)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  file = Buffer.from(
    `\ufeffsku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\nMILK-1,,Milk,Litre,${category},0401,500,false,false,9000,10000\nEGGS-1,,Eggs,Pack,${category},0407,500,true,true,8000,10000\n`,
  );
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${media}::uuid,${owner}::uuid,'CATALOG_IMPORT','private/source','text/csv',${file.length},'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  const identity = new DatabaseIdentityAccess(db.db);
  imports = new ImportService(db.db, identity, storage, config, {
    create: (a) => new MakerChecker(db.db, a),
  });
  worker = new CatalogImportWorker(db.db, identity, storage, config, imports);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('keeps dry runs isolated and applies replay-safe batches with durable checkpoints', async () => {
  const dry = await imports.create(owner, media, store, true);
  await worker.runOne();
  expect(await imports.get(owner, dry.id)).toMatchObject({
    status: 'COMPLETED',
    dryRun: true,
    rowsTotal: 2,
  });
  expect((await sql`SELECT id FROM catalog_variants`.execute(db.db)).rows).toHaveLength(0);
  const real = await imports.create(owner, media, store, false);
  expect(real.id).not.toBe(dry.id);
  await worker.runOne();
  await worker.runOne();
  expect(await imports.get(owner, real.id)).toMatchObject({ status: 'APPLYING', checkpoint: 1 });
  // Recreating a worker models process restart after a committed batch.
  worker = new CatalogImportWorker(
    db.db,
    new DatabaseIdentityAccess(db.db),
    storage,
    config,
    imports,
  );
  await worker.runOne();
  await worker.runOne();
  expect(await imports.get(owner, real.id)).toMatchObject({ status: 'COMPLETED', checkpoint: 2 });
  expect(await imports.create(owner, media, store, false)).toEqual(real);
  const duplicateMedia = uuidV7();
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${duplicateMedia}::uuid,${checker}::uuid,'CATALOG_IMPORT','private/duplicate','text/csv',${file.length},'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  expect(await imports.create(checker, duplicateMedia, store, false)).toEqual(real);
  expect(await imports.get(checker, real.id)).toMatchObject({ status: 'COMPLETED' });
  const counts = await sql<{
    variants: string;
    prices: string;
    assortment: string;
  }>`SELECT (SELECT count(*)::text FROM catalog_variants) variants,(SELECT count(*)::text FROM catalog_prices) prices,(SELECT count(*)::text FROM store_inventory WHERE on_hand=0) assortment`.execute(
    db.db,
  );
  expect(counts.rows[0]).toEqual({ variants: '2', prices: '2', assortment: '2' });
});

it('updates a published SKU without dropping its publication or price history', async () => {
  const image = uuidV7(),
    input = uuidV7();
  const variant = (
    await sql<{
      id: string;
      product_id: string;
    }>`SELECT id,product_id FROM catalog_variants WHERE sku='MILK-1'`.execute(db.db)
  ).rows[0]!;
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${image}::uuid,${owner}::uuid,'PRODUCT_IMAGE','public/import-image','image/png',12,'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_product_images(product_id,media_id) VALUES(${variant.product_id}::uuid,${image}::uuid)`.execute(
    db.db,
  );
  await sql`UPDATE catalog_products SET published=true WHERE id=${variant.product_id}::uuid`.execute(
    db.db,
  );
  file = Buffer.from(
    `sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\nMILK-1,,Milk Updated,Litre,${category},0401,500,false,false,8500,10000\n`,
  );
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${input}::uuid,${owner}::uuid,'CATALOG_IMPORT','private/published-update','text/csv',${file.length},'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  const job = await imports.create(owner, input, store, false);
  await worker.runOne();
  await worker.runOne();
  await worker.runOne();
  expect(await imports.get(owner, job.id)).toMatchObject({ status: 'COMPLETED', checkpoint: 1 });
  const result = await sql<{
    published: boolean;
    name: string;
    prices: string;
  }>`SELECT p.published,p.name,(SELECT count(*)::text FROM catalog_prices WHERE variant_id=${variant.id}::uuid) prices FROM catalog_products p WHERE p.id=${variant.product_id}::uuid`.execute(
    db.db,
  );
  expect(result.rows[0]).toEqual({ published: true, name: 'Milk Updated', prices: '2' });
});
it('rolls back a batch whose worker lease expires and replays it after recovery', async () => {
  const input = uuidV7();
  file = Buffer.from(
    `sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\nFENCED,,Fenced,Each,${category},1001,500,false,false,100,100\n`,
  );
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${input}::uuid,${owner}::uuid,'CATALOG_IMPORT','private/fenced','text/csv',${file.length},'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  const job = await imports.create(owner, input, store, false);
  await worker.runOne();
  await sql`CREATE FUNCTION expire_import_lease_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sku='FENCED' THEN UPDATE catalog_import_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE status='APPLYING' AND lease_token IS NOT NULL; END IF; RETURN NEW; END $$`.execute(
    db.db,
  );
  await sql`CREATE TRIGGER expire_import_lease_test AFTER INSERT ON catalog_variants FOR EACH ROW EXECUTE FUNCTION expire_import_lease_test()`.execute(
    db.db,
  );
  try {
    await worker.runOne();
    expect(
      (await sql`SELECT id FROM catalog_variants WHERE sku='FENCED'`.execute(db.db)).rows,
    ).toHaveLength(0);
    expect(await imports.get(owner, job.id)).toMatchObject({ status: 'APPLYING', checkpoint: 0 });
  } finally {
    await sql`DROP TRIGGER expire_import_lease_test ON catalog_variants`.execute(db.db);
    await sql`DROP FUNCTION expire_import_lease_test()`.execute(db.db);
  }
  await sql`UPDATE catalog_import_jobs SET lease_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE id=${job.id}::uuid`.execute(
    db.db,
  );
  await worker.runOne();
  await worker.runOne();
  expect(await imports.get(owner, job.id)).toMatchObject({ status: 'COMPLETED', checkpoint: 1 });
  expect(
    (await sql`SELECT id FROM catalog_variants WHERE sku='FENCED'`.execute(db.db)).rows,
  ).toHaveLength(1);
});
it('holds a qualifying bulk import for an audited approval before applying', async () => {
  const newMedia = uuidV7();
  values.catalogPriceApprovalCount = 1;
  file = Buffer.from(
    `sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\nTEA,,Tea,Pack,${category},0902,500,false,false,100,200\nCOFFEE,,Coffee,Pack,${category},0901,500,false,false,200,300\n`,
  );
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${newMedia}::uuid,${owner}::uuid,'CATALOG_IMPORT','private/new-source','text/csv',${file.length},'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  const job = await imports.create(owner, newMedia, store, false);
  await worker.runOne();
  await worker.runOne();
  let waiting = (await imports.get(owner, job.id)) as { status: string; approvalId: string };
  expect(waiting.status).toBe('AWAITING_APPROVAL');
  expect(waiting.approvalId).toBeTruthy();
  const expired = waiting.approvalId;
  await sql`UPDATE maker_checker_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired}::uuid`.execute(
    db.db,
  );
  await worker.runOne();
  waiting = (await imports.get(owner, job.id)) as { status: string; approvalId: string };
  expect(waiting.approvalId).not.toBe(expired);
  await expect(imports.approve(checker, expired)).rejects.toThrow();
  expect(
    (await sql`SELECT id FROM catalog_variants WHERE sku IN ('TEA','COFFEE')`.execute(db.db)).rows,
  ).toHaveLength(0);
  await imports.approve(owner, waiting.approvalId);
  await worker.runOne();
  await worker.runOne();
  await worker.runOne();
  expect(await imports.get(owner, job.id)).toMatchObject({ status: 'COMPLETED', checkpoint: 2 });
});
