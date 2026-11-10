import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { runner } from 'node-pg-migrate';
import request from 'supertest';
import { Client } from 'pg';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createApplication } from '../../src/bootstrap.js';
import { readEnv } from '../../src/config/env.schema.js';
import { startTestServices, type TestServices } from '../helpers/services.js';
const run = promisify(execFile);
let services: TestServices;
let app: NestFastifyApplication;
let directory: string;
beforeAll(async () => {
  services = await startTestServices();
  directory = await mkdtemp(join(tmpdir(), 'delivery-p11-'));
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
  await run(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTH_PROVIDER: 'local',
      DATABASE_URL: services.databaseUrl,
      LOCAL_CATALOG_STORAGE_DIR: join(directory, 'catalog'),
    },
  });
  const db = new Client({ connectionString: services.databaseUrl });
  await db.connect();
  try {
    const other = uuidV7();
    await db.query(
      "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER','p11-other','p11-other@test.invalid','Other',true)",
      [other],
    );
    await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER')", [other]);
    await db.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [other]);
  } finally {
    await db.end();
  }
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ROLE: 'all',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      LOCAL_PRIVATE_STORAGE_DIR: directory,
      LOCAL_CATALOG_STORAGE_DIR: join(directory, 'catalog'),
      RATE_LIMIT_DEFAULT_PER_MIN: '5000',
      RATE_LIMIT_AUTH_PER_MIN: '5000',
    }),
  );
}, 120000);
afterAll(async () => {
  await app?.close();
  await services?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120000);
async function token(
  pool: string,
  sub: string,
  audience: string,
  tokenUse = 'access',
): Promise<string> {
  const r = await request(app.getHttpServer())
    .post('/dev/auth/token')
    .send({ pool, sub, audience, tokenUse })
    .expect(201);
  return r.body.token as string;
}
it('validates ticket inputs and keeps staff internal notes off customer HTTP responses', async () => {
  const customer = await token('CUSTOMER', 'customer', 'customer'),
    customerId = await token('CUSTOMER', 'customer', 'customer', 'id'),
    admin = await token('WORKFORCE', 'admin', 'admin'),
    other = await token('CUSTOMER', 'p11-other', 'customer');
  const http = app.getHttpAdapter().getInstance(),
    c = { authorization: `Bearer ${customer}` },
    a = { authorization: `Bearer ${admin}` };
  expect(
    (
      await http.inject({
        method: 'POST',
        url: '/v1/customer/auth/bootstrap',
        headers: { authorization: `Bearer ${customerId}` },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await http.inject({
        method: 'POST',
        url: '/v1/customer/tickets',
        headers: c,
        payload: { category: 'issue', body: 'hello', unexpected: 'rejected' },
      })
    ).statusCode,
  ).toBe(400);
  const forbiddenApproval = await http.inject({
    method: 'POST',
    url: '/v1/admin/wallet/adjustments/00000000-0000-4000-8000-000000000001/approve',
    headers: a,
  });
  expect(forbiddenApproval.statusCode).toBe(403);
  const created = await http.inject({
    method: 'POST',
    url: '/v1/customer/tickets',
    headers: { ...c, 'idempotency-key': 'ticket-http-1' },
    payload: { category: 'issue', body: 'hello' },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const foreignHeaders = { authorization: `Bearer ${other}` };
  const foreignRead = await http.inject({
    method: 'GET',
    url: `/v1/customer/tickets/${id}`,
    headers: foreignHeaders,
  });
  expect(foreignRead.statusCode).toBe(404);
  const foreignMessage = await http.inject({
    method: 'POST',
    url: `/v1/customer/tickets/${id}/messages`,
    headers: foreignHeaders,
    payload: { body: 'foreign' },
  });
  expect(foreignMessage.statusCode).toBe(404);
  const messageHeaders = { ...c, 'idempotency-key': 'ticket-message-http' };
  const message = await http.inject({
    method: 'POST',
    url: `/v1/customer/tickets/${id}/messages`,
    headers: messageHeaders,
    payload: { body: 'owner-message' },
  });
  expect(message.statusCode).toBe(201);
  const messageReplay = await http.inject({
    method: 'POST',
    url: `/v1/customer/tickets/${id}/messages`,
    headers: messageHeaders,
    payload: { body: 'owner-message' },
  });
  expect(messageReplay.statusCode).toBe(201);
  expect(messageReplay.json()).toEqual(message.json());
  const messageConflict = await http.inject({
    method: 'POST',
    url: `/v1/customer/tickets/${id}/messages`,
    headers: messageHeaders,
    payload: { body: 'changed-message' },
  });
  expect(messageConflict.statusCode).toBe(409);
  const invalidMessage = await http.inject({
    method: 'POST',
    url: `/v1/customer/tickets/${id}/messages`,
    headers: c,
    payload: { body: 'valid', unexpected: 'canary' },
  });
  expect(invalidMessage.statusCode).toBe(400);
  expect(invalidMessage.body).not.toContain('canary');
  const replay = await http.inject({
    method: 'POST',
    url: '/v1/customer/tickets',
    headers: { ...c, 'idempotency-key': 'ticket-http-1' },
    payload: { category: 'issue', body: 'hello' },
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json().id).toBe(id);
  const conflict = await http.inject({
    method: 'POST',
    url: '/v1/customer/tickets',
    headers: { ...c, 'idempotency-key': 'ticket-http-1' },
    payload: { category: 'issue', body: 'changed' },
  });
  expect(conflict.statusCode).toBe(409);
  expect(
    (
      await http.inject({
        method: 'POST',
        url: `/v1/customer/tickets/${id}/messages`,
        headers: c,
        payload: { body: 'spoof', internal: true },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await http.inject({
        method: 'POST',
        url: `/v1/admin/tickets/${id}/messages`,
        headers: a,
        payload: { body: 'private-note', internal: true },
      })
    ).statusCode,
  ).toBe(201);
  const visible = await http.inject({
    method: 'GET',
    url: `/v1/customer/tickets/${id}`,
    headers: c,
  });
  expect(visible.statusCode).toBe(200);
  expect(visible.body).not.toContain('private-note');
  const aggregate = await http.inject({
    method: 'GET',
    url: '/v1/customer/ratings/RIDER/00000000-0000-0000-0000-000000000001/aggregate',
    headers: c,
  });
  expect(aggregate.statusCode).toBe(200);
  expect(aggregate.json()).toEqual({ aggregate: null });
  expect(
    (await http.inject({ method: 'GET', url: '/v1/admin/tickets', headers: c })).statusCode,
  ).toBe(401);
});
