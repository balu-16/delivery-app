import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { createApplication } from '../../../src/bootstrap.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { LocalPrivateUploads } from '../../../src/adapters/storage/local-private.js';
import { S3PrivateUploads } from '../../../src/adapters/storage/s3-private.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { readEnv } from '../../../src/config/env.schema.js';
import {
  IDENTITY_ACCESS,
  type IdentityAccess,
} from '../../../src/modules/identity/contracts/identity.js';
import { PRIVATE_UPLOADS } from '../../../src/modules/identity/contracts/uploads.js';
import { PostgresProfileCovers } from '../../../src/modules/identity/infrastructure/profile-covers.js';
import { LocalStorage } from '../../../src/modules/media/infrastructure/local-storage.js';
import { MediaOrphanCleanup } from '../../../src/modules/media/infrastructure/orphan-cleanup.js';
import { S3Storage } from '../../../src/modules/media/infrastructure/s3-storage.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

const coverPath = '/v1/customer/me/cover';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]);
let services: TestServices;
let db: DatabaseHandle;
let app: NestFastifyApplication;
let storage: LocalPrivateUploads;
let dir: string;
let ownerId: string;
let ownerToken: string;
let otherId: string;
let otherToken: string;
let cleanup: MediaOrphanCleanup;

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
  dir = await mkdtemp(join(tmpdir(), 'delivery-profile-cover-'));
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'customer',
    LOG_LEVEL: 'silent',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    LOCAL_PRIVATE_STORAGE_DIR: dir,
  });
  const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
  const customer = async (subject: string) => {
    const id = uuidV7();
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified)
      VALUES (${id}::uuid,'CUSTOMER',${subject},${subject + '@test.invalid'},${subject},true)`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES (${id}::uuid,'CUSTOMER')`.execute(db.db);
    return { id, access: await tokens.issue('CUSTOMER', subject, 'customer', 'access') };
  };
  const owner = await customer('cover-owner');
  ownerId = owner.id;
  ownerToken = owner.access;
  const other = await customer('cover-other');
  otherId = other.id;
  otherToken = other.access;
  app = await createApplication(env);
  storage = app.get<LocalPrivateUploads>(PRIVATE_UPLOADS);
  cleanup = new MediaOrphanCleanup(db.db, new LocalStorage(dir, env.LOCAL_JWT_SECRET, dir));
}, 120000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await services?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 120000);

function call(method: 'GET' | 'PUT' | 'POST', url: string, token?: string, payload?: object) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload ? { payload } : {}),
    });
}

async function upload(useToken = ownerToken) {
  const response = await call('POST', `${coverPath}/upload-target`, useToken, {
    size: jpeg.length,
  });
  expect(response.statusCode).toBe(201);
  const target = response.json() as {
    mediaId: string;
    url: string;
    fields: { authorization: string };
  };
  const send = (body: Buffer) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PUT',
        url: target.url,
        headers: {
          authorization: target.fields.authorization,
          'content-type': 'application/octet-stream',
        },
        payload: body,
      });
  expect((await send(Buffer.alloc(jpeg.length))).statusCode).toBe(404);
  expect((await send(jpeg)).statusCode).toBe(200);
  return target;
}

it('persists a preset, enforces revisions and keeps cover reads private', async () => {
  expect((await call('GET', coverPath)).statusCode).toBe(401);
  const initial = await call('GET', coverPath, ownerToken);
  expect(initial.json()).toEqual({ kind: 'default', version: '0', imageUrl: null });
  expect(initial.headers['cache-control']).toBe('private, no-store');
  expect((await call('GET', '/v1/customer/me', ownerToken)).json()).toMatchObject({
    emailVerified: true,
  });
  expect(
    (await call('POST', `${coverPath}/upload-target`, ownerToken, { size: 2097153 })).statusCode,
  ).toBe(400);
  const preset = { kind: 'preset', presetId: 'farm-meadow', expectedVersion: '0' };
  const saved = await call('PUT', coverPath, ownerToken, preset);
  expect(saved.json()).toEqual({
    kind: 'preset',
    presetId: 'farm-meadow',
    version: '1',
    imageUrl: null,
  });
  expect((await call('PUT', coverPath, ownerToken, preset)).json()).toEqual(saved.json());
  const stale = await call('PUT', coverPath, ownerToken, { kind: 'default', expectedVersion: '0' });
  expect(stale.statusCode).toBe(409);
  expect((await call('GET', coverPath, otherToken)).json()).toMatchObject({ kind: 'default' });

  const competing = await Promise.all([
    call('PUT', coverPath, ownerToken, {
      kind: 'preset',
      presetId: 'calf-at-sunrise',
      expectedVersion: '1',
    }),
    call('PUT', coverPath, ownerToken, { kind: 'default', expectedVersion: '1' }),
  ]);
  expect(competing.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  expect((await call('GET', coverPath, ownerToken)).json()).toEqual(
    competing.find((result) => result.statusCode === 200)?.json(),
  );
});

it('attaches only an owned upload, retires old photos and erases the last photo', async () => {
  const initial = (await call('GET', coverPath, ownerToken)).json() as { version: string };
  const target = await upload();
  await expect(storage.signedRead(target.mediaId, ownerId)).rejects.toThrow('MEDIA_NOT_FOUND');
  const foreign = await call('PUT', coverPath, otherToken, {
    kind: 'photo',
    mediaId: target.mediaId,
    expectedVersion: '0',
  });
  expect(foreign.statusCode).toBe(404);
  const saved = await call('PUT', coverPath, ownerToken, {
    kind: 'photo',
    mediaId: target.mediaId,
    expectedVersion: initial.version,
  });
  expect(saved.statusCode).toBe(200);
  const cover = saved.json() as { imageUrl: string; version: string };
  const image = await call('GET', cover.imageUrl);
  expect(image.statusCode).toBe(200);
  expect(image.rawPayload).toEqual(jpeg);
  await expect(storage.signedRead(target.mediaId)).rejects.toThrow('MEDIA_NOT_FOUND');
  expect((await call('GET', coverPath, ownerToken)).json()).toMatchObject({
    kind: 'photo',
    mediaId: target.mediaId,
    version: cover.version,
  });

  const file = await sql<{
    file_key: string;
  }>`SELECT file_key FROM private_media WHERE id=${target.mediaId}::uuid`.execute(db.db);
  const replacement = await upload();
  const replaced = await call('PUT', coverPath, ownerToken, {
    kind: 'photo',
    mediaId: replacement.mediaId,
    expectedVersion: cover.version,
  });
  expect(replaced.statusCode).toBe(200);
  expect((await call('GET', cover.imageUrl)).statusCode).toBe(404);
  const retired =
    await sql`SELECT id FROM private_media WHERE id=${target.mediaId}::uuid AND state='ERASING'`.execute(
      db.db,
    );
  expect(retired.rows).toHaveLength(1);
  while (await cleanup.runOne()) {
    /* Drain due cleanup rows for this isolated database. */
  }
  await expect(readFile(join(dir, file.rows[0]!.file_key))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(
    (await sql`SELECT id FROM private_media WHERE id=${target.mediaId}::uuid`.execute(db.db)).rows,
  ).toHaveLength(0);
  expect((await call('GET', replaced.json().imageUrl)).rawPayload).toEqual(jpeg);

  const reset = await call('PUT', coverPath, ownerToken, {
    kind: 'default',
    expectedVersion: replaced.json().version,
  });
  expect(reset.statusCode).toBe(200);
  expect((await call('GET', replaced.json().imageUrl)).statusCode).toBe(404);

  const abandoned = await upload();
  const abandonedFile = await sql<{
    file_key: string;
  }>`SELECT file_key FROM private_media WHERE id=${abandoned.mediaId}::uuid`.execute(db.db);
  await sql`UPDATE media_orphan_objects SET remove_after=clock_timestamp()-interval '1 second'
    WHERE object_key=${'kyc/final/' + abandonedFile.rows[0]!.file_key}`.execute(db.db);
  while (await cleanup.runOne()) {
    /* Drain the abandoned upload. */
  }
  await expect(readFile(join(dir, abandonedFile.rows[0]!.file_key))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const last = await upload();
  const latest = await call('PUT', coverPath, ownerToken, {
    kind: 'photo',
    mediaId: last.mediaId,
    expectedVersion: reset.json().version,
  });
  expect(latest.statusCode).toBe(200);
  await db.db.transaction().execute((tx) => storage.fenceForErasure(ownerId, tx));
  expect((await call('GET', coverPath, ownerToken)).json()).toMatchObject({ kind: 'default' });
  await sql`UPDATE privacy_media_fences SET ready_at=clock_timestamp()-interval '1 second' WHERE owner_id=${ownerId}::uuid`.execute(
    db.db,
  );
  await expect(storage.eraseFenced(ownerId)).resolves.toBe(true);
  expect((await call('GET', latest.json().imageUrl)).statusCode).toBe(404);
});

it('signs private S3 reads only for the current cover and removes a retired object', async () => {
  const client = new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const deleted: string[] = [];
  client.send = (async (command: unknown) => {
    if (command instanceof HeadObjectCommand)
      return { ContentLength: jpeg.length, ContentType: 'image/jpeg', ETag: '"staging-cover"' };
    if (command instanceof CopyObjectCommand) return {};
    if (command instanceof GetObjectCommand)
      return { Body: { transformToByteArray: async () => jpeg } };
    if (command instanceof DeleteObjectCommand) {
      deleted.push(command.input.Key!);
      return {};
    }
    throw new Error('Unexpected S3 command');
  }) as typeof client.send;

  try {
    const adapter = new S3PrivateUploads(db.db, client, 'private-covers', 2097152, 300, 60);
    const covers = new PostgresProfileCovers(
      db.db,
      app.get<IdentityAccess>(IDENTITY_ACCESS),
      adapter,
    );
    const target = await covers.uploadTarget(otherId, jpeg.length);
    await expect(adapter.signedRead(target.mediaId, otherId)).rejects.toThrow('MEDIA_NOT_FOUND');

    const saved = await covers.update(otherId, { kind: 'photo', mediaId: target.mediaId }, '0');
    const url = new URL(saved.imageUrl!);
    const key = url.pathname.slice(1);
    expect(key).toMatch(/^kyc\/final\//);
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
    await expect(adapter.signedRead(target.mediaId, ownerId)).rejects.toThrow('MEDIA_NOT_FOUND');
    await expect(adapter.signedRead(target.mediaId)).rejects.toThrow('MEDIA_NOT_FOUND');

    await covers.update(otherId, { kind: 'default' }, saved.version);
    await expect(adapter.signedRead(target.mediaId, otherId)).rejects.toThrow('MEDIA_NOT_FOUND');
    const orphanCleanup = new MediaOrphanCleanup(
      db.db,
      new S3Storage(client, 'media', 'private-covers'),
    );
    await expect(orphanCleanup.runOne()).resolves.toBe(true);
    expect(deleted).toContain(key);
  } finally {
    client.destroy();
  }
});
