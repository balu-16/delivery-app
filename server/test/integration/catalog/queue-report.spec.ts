import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { ConcernQueues } from '../../../src/platform/queue/concern-queues.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import type { ApprovalAction } from '../../../src/modules/compliance/contracts/approval.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { ImportService } from '../../../src/modules/catalog/infrastructure/import-service.js';
import { CatalogImportWorker } from '../../../src/modules/catalog/infrastructure/import-worker.js';
import { CatalogImportDispatcher } from '../../../src/modules/catalog/infrastructure/import-dispatcher.js';
import { ImportReports } from '../../../src/modules/catalog/infrastructure/import-reports.js';
import type { StoragePort } from '../../../src/modules/media/contracts/storage.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices, db: DatabaseHandle;
const owner = uuidV7(),
  category = uuidV7(),
  city = uuidV7(),
  entity = uuidV7(),
  store = uuidV7(),
  media = uuidV7();
const objects = new Map<string, Buffer>();
const settings = {
  catalogImportMaxBytes: 100000,
  catalogImportMaxRows: 100,
  catalogImportBatchSize: 10,
  catalogAllowedGstBps: [500],
  catalogPriceApprovalCount: 20,
  catalogPriceApprovalPercent: 20,
};
const config = {
  get: async <K extends ConfigKey>(key: K) =>
    settings[key as keyof typeof settings] as ConfigValues[K],
} satisfies AppConfig;
const storage = {
  open: async (key: string) => {
    const value = objects.get(key);
    if (!value) throw new Error('MEDIA_NOT_FOUND');
    return Readable.from([value]);
  },
  putPrivate: async (key: string, body: Buffer) => {
    objects.set(key, Buffer.from(body));
  },
  remove: async (key: string) => {
    objects.delete(key);
  },
} as unknown as StoragePort;
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
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${owner}::uuid,'WORKFORCE','queue-admin','queue@example.invalid','admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${owner}::uuid,'SUPER_ADMIN')`.execute(
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
  const file = Buffer.from(
    `sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise\nBAD,,Milk,Litre,${category},0401,999,false,false,9000,10000\n`,
  );
  objects.set('private/source', file);
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${media}::uuid,${owner}::uuid,'CATALOG_IMPORT','private/source','text/csv',${file.length},'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('recreates a lost queue hint and persists a recoverable private report', async () => {
  const identity = new DatabaseIdentityAccess(db.db),
    factory = {
      create: (a: Readonly<Record<string, ApprovalAction>>) => new MakerChecker(db.db, a),
    };
  const badQueue = {
    enqueue: async () => {
      throw new Error('redis unavailable');
    },
  };
  const imports = new ImportService(db.db, identity, storage, config, factory, badQueue as never);
  const job = await imports.create(owner, media, store, true);
  expect(await imports.get(owner, job.id)).toMatchObject({ status: 'QUEUED' });
  const worker = new CatalogImportWorker(db.db, identity, storage, config, imports);
  const queue = new ConcernQueues({ redisUrl: services.redisUrl, prefix: services.redisPrefix });
  const dispatcher = new CatalogImportDispatcher(db.db, queue, worker);
  dispatcher.start();
  try {
    const deadline = Date.now() + 10000;
    let state = '';
    while (Date.now() < deadline) {
      state = ((await imports.get(owner, job.id)) as { status: string }).status;
      if (state === 'COMPLETED') break;
      await delay(30);
    }
    expect(state).toBe('COMPLETED');
    while (Date.now() < deadline) {
      try {
        if ((await imports.report(owner, job.id)).includes('INVALID_GST')) break;
      } catch {
        // Report generation can finish after the job status commits.
      }
      await delay(30);
    }
    expect(await imports.report(owner, job.id)).toContain('INVALID_GST');
    const reference = await sql<{
      report_key: string;
    }>`SELECT report_key FROM catalog_import_jobs WHERE id=${job.id}::uuid`.execute(db.db);
    expect(reference.rows[0]!.report_key).toMatch(/^private\//);
    expect(objects.has(reference.rows[0]!.report_key)).toBe(true);
    const secondWorker = new CatalogImportWorker(db.db, identity, storage, config, imports);
    expect(await secondWorker.recoverReport(job.id)).toBe(false);
  } finally {
    await dispatcher.stop();
    await queue.close();
  }
});
it('retries an interrupted report write without losing the durable job', async () => {
  const id = uuidV7();
  await sql`INSERT INTO catalog_import_jobs(id,owner_id,media_id,fingerprint,dry_run,options,status,errors) VALUES(${id}::uuid,${owner}::uuid,${media}::uuid,${uuidV7()},true,'{}','FAILED','[{"row":3,"code":"=bad"}]'::jsonb)`.execute(
    db.db,
  );
  const failing = {
    ...storage,
    putPrivate: async () => {
      throw new Error('outage');
    },
  } as StoragePort;
  await expect(new ImportReports(db.db, failing).recoverOne(id)).rejects.toThrow('outage');
  expect(await new ImportReports(db.db, storage).recoverOne(id)).toBe(true);
  const imports = new ImportService(db.db, new DatabaseIdentityAccess(db.db), storage, config, {
    create: (a) => new MakerChecker(db.db, a),
  });
  expect(await imports.report(owner, id)).toContain('"\'=bad"');
  expect(
    (
      await sql`SELECT object_key FROM media_orphan_objects WHERE object_key LIKE ${`private/${id}/%`}`.execute(
        db.db,
      )
    ).rows,
  ).toHaveLength(1);
});
