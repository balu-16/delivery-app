import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { LocalPrivateUploads } from '../../../src/adapters/storage/local-private.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { createAwsTestQueues, trackAwsTestRateKeys } from '../../helpers/aws-test-queues.js';
import { PLATFORM_REDIS } from '../../../src/platform/contracts/runtime.js';
import type { Redis } from 'ioredis';
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
  db = createDatabase(
    services.databaseIamUrl ?? services.databaseUrl,
    4,
    30000,
    undefined,
    30000,
    services.databaseIamUrl ? process.env.AWS_REGION : undefined,
  );
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
  await db.db.transaction().execute((tx) => storage.fenceForErasure(rider, tx));
  await expect(storage.eraseFenced(rider)).resolves.toBe(false);
  await sql`UPDATE privacy_media_fences SET ready_at=clock_timestamp()-interval '1 second'
    WHERE owner_id=${rider}::uuid`.execute(db.db);
  await expect(storage.eraseFenced(rider)).resolves.toBe(true);
  await expect(storage.read(target.mediaId, url.searchParams.get('capability')!)).rejects.toThrow();
});
it('exposes onboarding upload and restricts reviewer access over HTTP', async () => {
  const { createApplication } = await import('../../../src/bootstrap.js');
  const { readEnv } = await import('../../../src/config/env.schema.js');
  const { LocalTokenAdapter } = await import('../../../src/adapters/auth/local.js');
  const rider = uuidV7(),
    admin = uuidV7(),
    other = uuidV7(),
    entity = uuidV7(),
    city = uuidV7(),
    store = uuidV7();
  for (const [id, subject, role] of [
    [rider, 'http-rider', 'RIDER'],
    [admin, 'http-admin', 'STORE_MANAGER'],
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
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'Entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'City',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'Store',ST_GeogFromText('POINT(0.5 0.5)'),'ONLINE',100)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${admin}::uuid,${store}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`UPDATE rider_profiles SET home_store_id=${store}::uuid WHERE user_id=${rider}::uuid`.execute(
    db.db,
  );
  const queue = services.databaseIamUrl ? await createAwsTestQueues() : undefined;
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: services.databaseIamUrl ?? services.databaseUrl,
    REDIS_URL: services.redisUrl,
    LOCAL_PRIVATE_STORAGE_DIR: dir,
    PRIVATE_UPLOAD_MAX_BYTES: '64',
    ...(queue
      ? {
          DATABASE_AUTH: 'iam',
          DB_ACQUIRE_TIMEOUT_MS: '30000',
          AWS_REGION: process.env.AWS_REGION,
          AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID,
          CACHE_AUTH: 'elasticache-iam',
          CACHE_URL: process.env.CACHE_URL,
          CACHE_IAM_NAME: process.env.CACHE_IAM_NAME,
          CACHE_IAM_USER: process.env.CACHE_IAM_USER,
          QUEUE_TRANSPORT: 'sqs',
          SQS_QUEUE_PREFIX: queue.prefix,
        }
      : {}),
  });
  const adapter = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
  const riderToken = await adapter.issue('WORKFORCE', 'http-rider', 'rider', 'access');
  const otherToken = await adapter.issue('WORKFORCE', 'http-other', 'rider', 'access');
  const adminToken = await adapter.issue('WORKFORCE', 'http-admin', 'store', 'access');
  const app = await createApplication(env).catch(async (error) => {
    await queue?.close();
    throw error;
  });
  const clearRateKeys = queue ? trackAwsTestRateKeys(app.get<Redis>(PLATFORM_REDIS)) : undefined;
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
    const beforeUpload = await server.inject({
      method: 'POST',
      url: '/v1/rider/onboarding/documents',
      headers,
      payload: { documentType: 'licence', mediaId: target.mediaId },
    });
    expect(beforeUpload.statusCode).toBe(409);
    expect(beforeUpload.json().code).toBe('UPLOAD_NOT_RECEIVED');
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
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json().code).toBe('MEDIA_NOT_FOUND');
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
    const url = `/v1/store/rider-documents/${doc.rows[0]!.id}/read-url`;
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

    // The admin portal preview uses the same short-lived read: a SUPER_ADMIN
    // token on the admin route returns a link and audits the read.
    const superAdmin = uuidV7();
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${superAdmin}::uuid,'WORKFORCE','http-super-admin',${`http-super-admin@test.invalid`},'http-super-admin')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${superAdmin}::uuid,'SUPER_ADMIN')`.execute(
      db.db,
    );
    const superAdminToken = await adapter.issue('WORKFORCE', 'http-super-admin', 'admin', 'access');
    const adminRead = await server.inject({
      method: 'GET',
      url: `/v1/admin/rider-documents/${doc.rows[0]!.id}/read-url`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(adminRead.statusCode).toBe(200);
    expect(typeof adminRead.json().url).toBe('string');
    const adminFile = await server.inject({ method: 'GET', url: adminRead.json().url });
    expect(adminFile.statusCode).toBe(200);
    expect(adminFile.rawPayload).toEqual(body);
    const audit = await sql<{
      action: string;
    }>`SELECT action FROM audit_log WHERE actor_id=${superAdmin}::uuid AND action='RIDER_DOCUMENT_READ'`.execute(
      db.db,
    );
    expect(audit.rows).toHaveLength(1);
    // A store manager on the admin audience is denied by the role gate, and
    // a manager without the home-store assignment never reaches the read.
    const managerAdminToken = await adapter.issue('WORKFORCE', 'http-admin', 'admin', 'access');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: `/v1/admin/rider-documents/${doc.rows[0]!.id}/read-url`,
          headers: { authorization: `Bearer ${managerAdminToken}` },
        })
      ).statusCode,
    ).toBe(403);

    const tickets = '/v1/rider/onboarding/tickets';
    const ticket = await server.inject({
      method: 'POST',
      url: tickets,
      headers: { ...headers, 'idempotency-key': uuidV7() },
      payload: { body: 'Could you check my application?' },
    });
    expect(ticket.statusCode).toBe(201);
    const ticketId = ticket.json().id;
    const list = await server.inject({ method: 'GET', url: tickets, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({ id: ticketId, category: 'ONBOARDING' }),
    ]);
    const reply = await server.inject({
      method: 'POST',
      url: `${tickets}/${ticketId}/messages`,
      headers: { ...headers, 'idempotency-key': uuidV7() },
      payload: { body: 'Here are more details.' },
    });
    expect(reply.statusCode).toBe(201);
    const thread = await server.inject({ method: 'GET', url: `${tickets}/${ticketId}`, headers });
    expect(thread.statusCode).toBe(200);
    expect(thread.json().messages.map((message: { body: string }) => message.body)).toEqual([
      'Could you check my application?',
      'Here are more details.',
    ]);
    const foreignThread = await server.inject({
      method: 'GET',
      url: `${tickets}/${ticketId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(foreignThread.statusCode).toBe(404);
  } finally {
    try {
      await clearRateKeys?.();
    } finally {
      try {
        await app.close();
      } finally {
        await queue?.close();
      }
    }
  }
});
