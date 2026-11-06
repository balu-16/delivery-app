import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { CatalogMediaService } from '../../../src/modules/media/infrastructure/catalog-media.js';
import { MediaOrphanCleanup } from '../../../src/modules/media/infrastructure/orphan-cleanup.js';
import { LocalStorage } from '../../../src/modules/media/infrastructure/local-storage.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices,
  db: DatabaseHandle,
  dir: string,
  storage: LocalStorage,
  media: CatalogMediaService;
const admin = uuidV7(),
  other = uuidV7(),
  category = uuidV7(),
  product = uuidV7();
const config = {
  get: async <K extends ConfigKey>(_key: K) => 100000 as ConfigValues[K],
} satisfies AppConfig;
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
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
  dir = await mkdtemp(join(tmpdir(), 'catalog-media-'));
  for (const [id, sub] of [
    [admin, 'admin-media'],
    [other, 'other-media'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${sub},${sub + '@example.invalid'},${sub})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,'ADMIN')`.execute(db.db);
  }
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name) VALUES(${product}::uuid,${category}::uuid,'Milk','milk')`.execute(
    db.db,
  );
  storage = new LocalStorage(dir, 'long-local-development-secret');
  media = new CatalogMediaService(db.db, new DatabaseIdentityAccess(db.db), storage, config, 300);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 120000);
it('binds upload to owner and type; promotion stays immutable and orphans are removed', async () => {
  const target = await media.target(admin, 'PRODUCT_IMAGE', 'image/png', png.length),
    token = target.fields.authorization!.slice(7);
  await storage.upload(target.mediaId, token, png);
  await expect(storage.upload(target.mediaId, token, png)).rejects.toThrow();
  await expect(media.register(other, target.mediaId, product)).rejects.toThrow('MEDIA_NOT_FOUND');
  await media.register(admin, target.mediaId, product);
  const object = await media.publicRead(target.mediaId),
    chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(png);
  const orphan = await sql<{
    object_key: string;
  }>`SELECT object_key FROM media_orphan_objects WHERE object_key LIKE ${`staging/${target.mediaId}/%`}`.execute(
    db.db,
  );
  expect(orphan.rows).toHaveLength(1);
  await sql`UPDATE media_orphan_objects SET remove_after=clock_timestamp()-interval '1 second' WHERE object_key=${orphan.rows[0]!.object_key}`.execute(
    db.db,
  );
  await new MediaOrphanCleanup(db.db, storage).runOne();
  await expect(storage.inspect(orphan.rows[0]!.object_key)).rejects.toThrow('MEDIA_NOT_FOUND');
  const still = await media.publicRead(target.mediaId);
  const parts: Buffer[] = [];
  for await (const chunk of still.body) parts.push(Buffer.from(chunk));
  expect(Buffer.concat(parts)).toEqual(png);
});
it('rejects spoofed image bytes after immutable promotion', async () => {
  const target = await media.target(admin, 'PRODUCT_IMAGE', 'image/png', 12);
  await storage.upload(target.mediaId, target.fields.authorization!.slice(7), Buffer.alloc(12));
  await expect(media.register(admin, target.mediaId, product)).rejects.toThrow('INVALID_MEDIA');
  const pending = await sql<{
    state: string;
  }>`SELECT state FROM catalog_media WHERE id=${target.mediaId}::uuid`.execute(db.db);
  expect(pending.rows[0]?.state).toBe('PENDING');
});

it('cannot register a final object already claimed by cleanup', async () => {
  class ClaimedStorage extends LocalStorage {
    override async promote(source: string, final: string, etag: string) {
      await super.promote(source, final, etag);
      await sql`UPDATE media_orphan_objects SET lease_token=${uuidV7()}::uuid,lease_until=clock_timestamp()+interval '1 minute' WHERE object_key=${final}`.execute(
        db.db,
      );
    }
  }
  const claimed = new ClaimedStorage(dir, 'long-local-development-secret');
  const service = new CatalogMediaService(
    db.db,
    new DatabaseIdentityAccess(db.db),
    claimed,
    config,
    300,
  );
  const target = await service.target(admin, 'PRODUCT_IMAGE', 'image/png', png.length);
  await claimed.upload(target.mediaId, target.fields.authorization!.slice(7), png);
  await expect(service.register(admin, target.mediaId, product)).rejects.toThrow('MEDIA_NOT_FOUND');
  const state = await sql<{
    state: string;
  }>`SELECT state FROM catalog_media WHERE id=${target.mediaId}::uuid`.execute(db.db);
  expect(state.rows[0]?.state).toBe('PENDING');
});
it('retains a failed cleanup for retry and never claims a registered object', async () => {
  const key = `public/${uuidV7()}/${uuidV7()}`;
  const registered = (
    await sql<{
      object_key: string;
    }>`SELECT object_key FROM catalog_media WHERE state='REGISTERED' LIMIT 1`.execute(db.db)
  ).rows[0]!.object_key;
  await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${registered},clock_timestamp()-interval '2 second')`.execute(
    db.db,
  );
  await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${key},clock_timestamp()-interval '1 second')`.execute(
    db.db,
  );
  let calls = 0;
  const failing = {
    remove: async () => {
      calls++;
      throw new Error('provider down');
    },
  } as unknown as import('../../../src/modules/media/contracts/storage.js').StoragePort;
  await expect(new MediaOrphanCleanup(db.db, failing).runOne()).rejects.toThrow('provider down');
  const queued = await sql<{
    attempts: number;
    lease_token: string | null;
  }>`SELECT attempts,lease_token FROM media_orphan_objects WHERE object_key=${key}`.execute(db.db);
  expect(queued.rows[0]).toEqual({ attempts: 1, lease_token: null });
  await sql`UPDATE media_orphan_objects SET remove_after=clock_timestamp()-interval '1 second' WHERE object_key=${key}`.execute(
    db.db,
  );
  await new MediaOrphanCleanup(db.db, {
    remove: async () => {
      calls++;
    },
  } as unknown as import('../../../src/modules/media/contracts/storage.js').StoragePort).runOne();
  expect(calls).toBe(2);
  expect(
    (
      await sql`SELECT object_key FROM media_orphan_objects WHERE object_key=${registered}`.execute(
        db.db,
      )
    ).rows,
  ).toHaveLength(1);
  await sql`DELETE FROM media_orphan_objects WHERE object_key=${registered}`.execute(db.db);
  expect(
    (await sql`SELECT object_key FROM media_orphan_objects WHERE object_key=${key}`.execute(db.db))
      .rows,
  ).toHaveLength(0);
});
