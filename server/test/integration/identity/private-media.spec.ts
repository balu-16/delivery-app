import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { LocalPrivateUploads } from '../../../src/adapters/storage/local-private.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices;
let db: DatabaseHandle;
let dir: string;
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
  dir = await mkdtemp(join(tmpdir(), 'delivery-private-test-'));
}, 120_000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 120_000);
it('limits upload to owner, expected type, size and one successful capability use', async () => {
  const rider = uuidV7(),
    other = uuidV7();
  for (const [id, subject] of [
    [rider, 'private-rider'],
    [other, 'private-other'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${id}::uuid,'WORKFORCE',${subject},${`${subject}@test.invalid`},${subject})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES (${id}::uuid,'RIDER')`.execute(db.db);
    await sql`INSERT INTO rider_profiles(user_id,status) VALUES (${id}::uuid,'PENDING')`.execute(
      db.db,
    );
  }
  const storage = new LocalPrivateUploads(db.db, 'a-long-development-secret', dir, 1000, 300, 60);
  const body = Buffer.from('%PDF-test');
  const target = await storage.createTarget(rider, 'RIDER_KYC', 'application/pdf', body.length);
  const token = target.fields.authorization!.slice('Bearer '.length);
  await expect(storage.upload(target.mediaId, token, Buffer.from('bad'))).rejects.toThrow();
  await expect(storage.upload(target.mediaId, token, Buffer.alloc(body.length))).rejects.toThrow();
  await storage.upload(target.mediaId, token, body);
  await expect(storage.upload(target.mediaId, token, body)).rejects.toThrow();
  await expect(storage.assertOwnedRegistered(other, target.mediaId, 'RIDER_KYC')).rejects.toThrow(
    'MEDIA_NOT_FOUND',
  );
  await expect(
    storage.assertOwnedRegistered(rider, target.mediaId, 'RIDER_KYC'),
  ).resolves.toBeUndefined();
  const url = new URL(await storage.signedRead(target.mediaId), 'http://local.invalid');
  expect((await storage.read(target.mediaId, url.searchParams.get('capability')!)).body).toEqual(
    body,
  );
  await expect(storage.read(target.mediaId, token)).rejects.toThrow();
});
it('exposes onboarding upload and restricts reviewer access over HTTP', async () => {
  const { createApplication } = await import('../../../src/bootstrap.js');
  const { readEnv } = await import('../../../src/config/env.schema.js');
  const { LocalTokenAdapter } = await import('../../../src/adapters/auth/local.js');
  const rider = uuidV7(),
    admin = uuidV7(),
    other = uuidV7();
  for (const [id, subject, role] of [
    [rider, 'http-rider', 'RIDER'],
    [admin, 'http-admin', 'ADMIN'],
    [other, 'http-other', 'RIDER'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${id}::uuid,'WORKFORCE',${subject},${`${subject}@test.invalid`},${subject})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES (${id}::uuid,${role})`.execute(db.db);
    if (role === 'RIDER')
      await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no) VALUES (${id}::uuid,'PENDING','bike','ABC')`.execute(
        db.db,
      );
  }
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    LOCAL_PRIVATE_STORAGE_DIR: dir,
    PRIVATE_UPLOAD_MAX_BYTES: '64',
  });
  const adapter = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
  const riderToken = await adapter.issue('WORKFORCE', 'http-rider', 'rider', 'access');
  const otherToken = await adapter.issue('WORKFORCE', 'http-other', 'rider', 'access');
  const adminToken = await adapter.issue('WORKFORCE', 'http-admin', 'admin', 'access');
  const app = await createApplication(env);
  try {
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: `Bearer ${riderToken}` },
      body = Buffer.from('%PDF-document');
    const targetResponse = await server.inject({
      method: 'POST',
      url: '/v1/rider/onboarding/documents/upload-url',
      headers,
      payload: { contentType: 'application/pdf', size: body.length },
    });
    expect(targetResponse.statusCode).toBe(201);
    const target = targetResponse.json();
    const upload = await server.inject({
      method: 'PUT',
      url: target.url,
      headers: {
        authorization: target.fields.authorization,
        'content-type': 'application/octet-stream',
      },
      payload: body,
    });
    expect(upload.statusCode).toBe(200);
    const oversized = await server.inject({
      method: 'PUT',
      url: target.url,
      headers: {
        authorization: target.fields.authorization,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(65),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers['content-type']).toContain('application/problem+json');
    const wrongRoute = await server.inject({
      method: 'POST',
      url: '/v1/rider/onboarding/documents',
      headers: {
        authorization: `Bearer ${riderToken}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('no'),
    });
    expect(wrongRoute.statusCode).toBe(415);
    expect(wrongRoute.headers['content-type']).toContain('application/problem+json');
    const stolen = await server.inject({
      method: 'POST',
      url: '/v1/rider/onboarding/documents',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { documentType: 'licence', mediaId: target.mediaId },
    });
    expect(stolen.statusCode).toBe(400);
    const registration = await server.inject({
      method: 'POST',
      url: '/v1/rider/onboarding/documents',
      headers,
      payload: { documentType: 'licence', mediaId: target.mediaId },
    });
    expect(registration.statusCode).toBe(201);
    const doc = await sql<{
      id: string;
    }>`SELECT id FROM rider_documents WHERE media_id=${target.mediaId}::uuid`.execute(db.db);
    const url = `/v1/admin/rider-documents/${doc.rows[0]!.id}/read-url`;
    expect(
      (
        await server.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${riderToken}` },
        })
      ).statusCode,
    ).toBe(401);
    const read = await server.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(read.statusCode).toBe(200);
    const file = await server.inject({ method: 'GET', url: read.json().url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload).toEqual(body);
  } finally {
    await app.close();
  }
});
