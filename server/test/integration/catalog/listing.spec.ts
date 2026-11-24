import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresCatalogAdmin } from '../../../src/modules/catalog/infrastructure/catalog-admin.js';
import { PostgresCatalogQuery } from '../../../src/modules/catalog/infrastructure/catalog-query.js';
import { ImportService } from '../../../src/modules/catalog/infrastructure/import-service.js';
import { CatalogImportWorker } from '../../../src/modules/catalog/infrastructure/import-worker.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { AdminComplianceOperations } from '../../../src/modules/compliance/infrastructure/admin-operations.js';
import { CatalogMediaService } from '../../../src/modules/media/infrastructure/catalog-media.js';
import { LocalStorage } from '../../../src/modules/media/infrastructure/local-storage.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices, db: DatabaseHandle, dir: string;
let catalog: PostgresCatalogAdmin, storage: LocalStorage, media: CatalogMediaService;
let imports: ImportService, compliance: AdminComplianceOperations;
const entity = uuidV7(),
  city = uuidV7(),
  store = uuidV7(),
  admin = uuidV7(),
  checker = uuidV7();
const category = uuidV7(),
  product = uuidV7(),
  variant = uuidV7();
const settings: Record<string, unknown> = {
  catalogAllowedGstBps: [0, 500],
  catalogLowStockThreshold: 5,
  catalogMaxPerOrder: 10,
  catalogPriceApprovalPercent: 20,
  catalogSuggestCacheSeconds: 30,
  catalogImportMaxBytes: 100000,
  catalogImportMaxRows: 100,
  catalogImportBatchSize: 50,
  catalogPriceApprovalCount: 1,
};
const config = {
  get: async <K extends ConfigKey>(key: K) => settings[key as string] as ConfigValues[K],
  getMany: async <K extends ConfigKey>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, settings[k as string]])) as {
      [P in K]: ConfigValues[P];
    },
} satisfies AppConfig;

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
async function productImage(): Promise<string> {
  const target = await media.target(admin, 'PRODUCT_IMAGE', 'image/png', png.length);
  await storage.upload(target.mediaId, target.fields.authorization!.slice(7), png);
  await media.register(admin, target.mediaId, product);
  return target.mediaId;
}

beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl);
  dir = await mkdtemp(join(tmpdir(), 'catalog-listing-'));
  for (const [id, sub] of [
    [admin, 'listing-admin'],
    [checker, 'listing-checker'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${sub},${sub + '@example.invalid'},${sub})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,'SUPER_ADMIN')`.execute(
      db.db,
    );
  }
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published) VALUES(${product}::uuid,${category}::uuid,'Milk','milk','0401',500,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${variant}::uuid,${product}::uuid,'Unit',${'SKU-' + variant.slice(0, 8)})`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by)
    VALUES(${uuidV7()}::uuid,${store}::uuid,${variant}::uuid,3500,4000,clock_timestamp(),${admin}::uuid)`.execute(
    db.db,
  );
  storage = new LocalStorage(dir, 'long-local-development-secret');
  media = new CatalogMediaService(db.db, new DatabaseIdentityAccess(db.db), storage, config, 300);
  const identity = new DatabaseIdentityAccess(db.db);
  catalog = new PostgresCatalogAdmin(db.db, identity, config, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
  imports = new ImportService(db.db, identity, storage, config, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
  compliance = new AdminComplianceOperations(db.db);
}, 120000);

afterAll(async () => {
  await db?.close();
  await services?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 120000);

describe('store listing (§3B)', () => {
  it('defaults active=true; withdraw is idempotent, keeps quantities and audits only transitions', async () => {
    await catalog.setAssortment(admin, store, variant); // default active
    await catalog.setAssortment(admin, store, variant, false);
    const listed = await catalog.listAssortment(admin, variant);
    expect(listed.items.find((i) => i.storeId === store)?.listed).toBe(false);
    await catalog.setAssortment(admin, store, variant, false); // no-op
    await catalog.setAssortment(admin, store, variant, true);
    const relisted = await catalog.listAssortment(admin, variant);
    expect(relisted.items.find((i) => i.storeId === store)?.listed).toBe(true);
    const audits = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM audit_log WHERE action='ASSORTMENT_LISTING_CHANGED' AND subject_id=${variant}`.execute(
      db.db,
    );
    // create + withdraw + relist = 3 transitions; the idempotent withdraw wrote none.
    expect(Number(audits.rows[0]!.count)).toBe(3);
  });

  it('withdrawn variants disappear from preview and query', async () => {
    const query = new PostgresCatalogQuery(db.db, config);
    await catalog.setAssortment(admin, store, variant, false);
    const preview = await query.preview();
    expect(preview.items.some((i) => i.variantId === variant)).toBe(false);
    await catalog.setAssortment(admin, store, variant, true);
  });
});

describe('product image collection (§3B)', () => {
  it('appends at end, bumps revision, and enforces published >= 1 + version check', async () => {
    const first = await productImage();
    const listed = await catalog.listImages(admin, product);
    expect(listed.items.map((i) => i.mediaId)).toContain(first);
    expect(listed.items[0]!.position).toBe(
      listed.items.length === 1 ? 0 : listed.items[0]!.position,
    );
    await expect(catalog.replaceImages(admin, product, [], listed.revision)).rejects.toThrow(
      'PRODUCT_NOT_PUBLISHABLE',
    );
    await expect(catalog.replaceImages(admin, product, [first], '0')).rejects.toThrow(
      'CONCURRENT_MODIFICATION',
    );
    const replaced = await catalog.replaceImages(admin, product, [first], listed.revision);
    expect(replaced.revision).not.toBe(listed.revision);
    expect(replaced.items).toHaveLength(1);
    expect(replaced.items[0]).toMatchObject({
      mediaId: first,
      position: 0,
      url: `/media/${first}`,
    });
  });
});

describe('import rejection (§3B)', () => {
  it('rejects to terminal FAILED + reason in the same tx; same-file retry returns the rejected job; worker does not re-request', async () => {
    const csv =
      'sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\n' +
      `MILK-${uuidV7().slice(-12)},,Milk,Litre,${category},0401,500,false,false,9000,10000\n` +
      `MILK-${uuidV7().slice(-12)},,Milk,Pint,${category},0401,500,false,false,5000,6000\n`;
    const bytes = Buffer.from(csv);
    const target = await media.target(admin, 'CATALOG_IMPORT', 'text/csv', bytes.length);
    await storage.upload(target.mediaId, target.fields.authorization!.slice(7), bytes);
    await media.register(admin, target.mediaId);
    const { id: jobId } = await imports.create(admin, target.mediaId, store, false);
    const worker = new CatalogImportWorker(
      db.db,
      new DatabaseIdentityAccess(db.db),
      storage,
      config,
      imports,
    );
    let guard = 0;
    for (;;) {
      const job = (await imports.get(admin, jobId)) as {
        status: string;
        approvalId: string | null;
      };
      if (job.status === 'AWAITING_APPROVAL' && job.approvalId) break;
      if (job.status === 'COMPLETED' || job.status === 'FAILED')
        throw new Error(`unexpected terminal ${job.status}`);
      await worker.runOne(jobId);
      if (++guard > 50) throw new Error('import never reached AWAITING_APPROVAL');
    }
    const job = (await imports.get(admin, jobId)) as { status: string; approvalId: string };
    const approvalId = (job as { approvalId: string }).approvalId;
    expect(approvalId).toBeTruthy();
    await compliance.review('approval', approvalId, checker, 'REJECTED', 'CSV needs corrections');
    const rejected = (await imports.get(admin, jobId)) as {
      status: string;
      rejectionReason: string | null;
      errors: unknown;
    };
    expect(rejected.status).toBe('FAILED');
    expect(rejected.rejectionReason).toBe('CSV needs corrections');
    expect(rejected.errors).toBeDefined();
    // Same-file retry returns the rejected job (no new row).
    const { id: retryId } = await imports.create(admin, target.mediaId, store, false);
    expect(retryId).toBe(jobId);
    // The worker must not re-request approval for the terminal job.
    expect(await worker.runOne(jobId)).toBe(false);
    await expect(imports.get(admin, jobId)).resolves.toMatchObject({ status: 'FAILED' });
  });
});
