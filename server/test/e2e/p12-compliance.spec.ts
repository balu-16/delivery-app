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
import { PLATFORM_DATABASE } from '../../src/platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../src/platform/database/database.js';
import { APP_CONFIG, type AppConfig } from '../../src/modules/app-config/contracts/config.js';
import { MEDIA_STORAGE, type StoragePort } from '../../src/modules/media/contracts/storage.js';
import {
  REPORT_DATA,
  type ReportData,
} from '../../src/modules/compliance/contracts/report-data.js';
import { ExportWorker } from '../../src/modules/compliance/infrastructure/export-worker.js';
import { createApplication } from '../../src/bootstrap.js';
import { readEnv } from '../../src/config/env.schema.js';
import { startTestServices, type TestServices } from '../helpers/services.js';
const run = promisify(execFile);
let services: TestServices;
let app: NestFastifyApplication;
let directory: string;
beforeAll(async () => {
  services = await startTestServices();
  directory = await mkdtemp(join(tmpdir(), 'delivery-p12-'));
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
      "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER','p12-other','p12-other@test.invalid','Other',true)",
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
    [{ name: 'test', async check() {} }],
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
it('enforces privacy and report permissions, validation and resource ownership', async () => {
  const customer = await token('CUSTOMER', 'customer', 'customer');
  const other = await token('CUSTOMER', 'p12-other', 'customer');
  const idToken = await token('CUSTOMER', 'customer', 'customer', 'id');
  const admin = await token('WORKFORCE', 'admin', 'admin');
  const superAdmin = await token('WORKFORCE', 'super-admin-1', 'admin');
  const http = app.getHttpAdapter().getInstance();
  const c = { authorization: `Bearer ${customer}` },
    a = { authorization: `Bearer ${admin}` };
  expect(
    (
      await http.inject({
        method: 'POST',
        url: '/v1/customer/auth/bootstrap',
        headers: { authorization: `Bearer ${idToken}` },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (await http.inject({ method: 'GET', url: '/v1/admin/reports/catalog', headers: c })).statusCode,
  ).toBe(401);
  expect(
    (
      await http.inject({
        method: 'POST',
        url: '/v1/admin/reports/exports',
        headers: { ...a, 'idempotency-key': 'bad' },
        payload: { kind: 'catalog', unexpected: true },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await http.inject({ method: 'GET', url: '/v1/admin/reports/catalog?limit=101', headers: a }))
      .statusCode,
  ).toBe(400);
  const reportHeaders = { ...a, 'idempotency-key': 'admin-report-http' };
  const report = await http.inject({
    method: 'POST',
    url: '/v1/admin/reports/exports',
    headers: reportHeaders,
    payload: { kind: 'catalog' },
  });
  expect(report.statusCode).toBe(201);
  const reportId = report.json().id as string;
  const reportReplay = await http.inject({
    method: 'POST',
    url: '/v1/admin/reports/exports',
    headers: reportHeaders,
    payload: { kind: 'catalog' },
  });
  expect(reportReplay.statusCode).toBe(201);
  expect(reportReplay.json()).toEqual(report.json());
  const reportConflict = await http.inject({
    method: 'POST',
    url: '/v1/admin/reports/exports',
    headers: reportHeaders,
    payload: { kind: 'stock' },
  });
  expect(reportConflict.statusCode).toBe(409);
  const reportDetail = await http.inject({
    method: 'GET',
    url: `/v1/admin/reports/exports/${reportId}`,
    headers: a,
  });
  expect(reportDetail.statusCode).toBe(200);
  expect(reportDetail.json()).toMatchObject({ id: reportId, kind: 'catalog' });
  const reportList = await http.inject({
    method: 'GET',
    url: '/v1/admin/reports/exports',
    headers: a,
  });
  expect(reportList.statusCode).toBe(200);
  expect(reportList.json().items.some((item: { id: string }) => item.id === reportId)).toBe(true);
  const notReady = await http.inject({
    method: 'GET',
    url: `/v1/admin/reports/exports/${reportId}/download`,
    headers: a,
  });
  expect(notReady.statusCode).toBe(409);
  const preview = await http.inject({
    method: 'GET',
    url: '/v1/admin/reports/catalog?limit=1',
    headers: a,
  });
  expect(preview.statusCode).toBe(200);
  const db = new Client({ connectionString: services.databaseUrl });
  await db.connect();
  const signalId = uuidV7();
  const findingId = uuidV7();
  try {
    await db.query(
      "INSERT INTO fraud_signals(id,kind,severity,reference) VALUES($1,'CHECKOUT_VELOCITY','WARN',$1)",
      [signalId],
    );
    await db.query(
      "INSERT INTO reconciliation_findings(id,kind,severity,aggregate_type,aggregate_id,reference) VALUES($1,'MISMATCH','WARN','order',$1,$1)",
      [findingId],
    );
  } finally {
    await db.end();
  }
  const superHeaders = { authorization: `Bearer ${superAdmin}` };
  for (const [kind, id] of [
    ['fraud-signals', signalId],
    ['payments/reconciliation', findingId],
  ]) {
    const url = `/v1/admin/${kind}/${id}`;
    expect((await http.inject({ method: 'GET', url, headers: a })).statusCode).toBe(403);
    expect((await http.inject({ method: 'GET', url, headers: superHeaders })).statusCode).toBe(200);
    const payload = {
      decision: kind === 'fraud-signals' ? 'ESCALATED' : 'RESOLVED',
      reason: 'verified',
    };
    expect(
      (await http.inject({ method: 'POST', url: `${url}/review`, headers: a, payload })).statusCode,
    ).toBe(403);
    expect(
      (
        await http.inject({
          method: 'POST',
          url: `${url}/review`,
          headers: superHeaders,
          payload: { ...payload, unexpected: 'canary' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await http.inject({ method: 'POST', url: `${url}/review`, headers: superHeaders, payload }))
        .statusCode,
    ).toBe(201);
    expect(
      (await http.inject({ method: 'POST', url: `${url}/review`, headers: superHeaders, payload }))
        .statusCode,
    ).toBe(409);
  }
  const created = await http.inject({
    method: 'POST',
    url: '/v1/customer/me/data-exports',
    headers: { ...c, 'idempotency-key': 'privacy-http' },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const replay = await http.inject({
    method: 'POST',
    url: '/v1/customer/me/data-exports',
    headers: { ...c, 'idempotency-key': 'privacy-http' },
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json().id).toBe(id);
  const foreign = await http.inject({
    method: 'GET',
    url: `/v1/customer/me/data-exports/${id}`,
    headers: { authorization: `Bearer ${other}` },
  });
  expect(foreign.statusCode).toBe(404);
  const foreignDownload = await http.inject({
    method: 'GET',
    url: `/v1/customer/me/data-exports/${id}/download`,
    headers: { authorization: `Bearer ${other}` },
  });
  expect(foreignDownload.statusCode).toBe(404);
  const ownerDownload = await http.inject({
    method: 'GET',
    url: `/v1/customer/me/data-exports/${id}/download`,
    headers: c,
  });
  expect(ownerDownload.statusCode).toBe(409);
  const detail = await http.inject({
    method: 'GET',
    url: `/v1/customer/me/data-exports/${id}`,
    headers: c,
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toEqual(
    expect.objectContaining({ id, kind: 'personal', status: expect.any(String) }),
  );
  const worker = new ExportWorker(
    app.get<DatabaseHandle>(PLATFORM_DATABASE).db,
    app.get<StoragePort>(MEDIA_STORAGE),
    app.get<AppConfig>(APP_CONFIG),
    app.get<ReportData>(REPORT_DATA),
  );
  for (let i = 0; i < 2; i++) await worker.runOne();
  const completedDownload = await http.inject({
    method: 'GET',
    url: `/v1/customer/me/data-exports/${id}/download`,
    headers: c,
  });
  expect(completedDownload.statusCode).toBe(200);
  expect(completedDownload.json().url).toBeTruthy();
  const otherCompletedDownload = await http.inject({
    method: 'GET',
    url: `/v1/customer/me/data-exports/${id}/download`,
    headers: { authorization: `Bearer ${other}` },
  });
  expect(otherCompletedDownload.statusCode).toBe(404);
  const personalFile = await http.inject({ method: 'GET', url: completedDownload.json().url });
  expect(personalFile.statusCode).toBe(200);
  expect(personalFile.body).not.toContain('private-note');
  const adminDownload = await http.inject({
    method: 'GET',
    url: `/v1/admin/reports/exports/${reportId}/download`,
    headers: a,
  });
  expect(adminDownload.statusCode).toBe(200);
  expect(adminDownload.json().url).toBeTruthy();
  const adminFile = await http.inject({ method: 'GET', url: adminDownload.json().url });
  expect(adminFile.statusCode).toBe(200);
  expect(
    (await http.inject({ method: 'GET', url: `/v1/admin/reports/exports/${id}`, headers: a }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await http.inject({
        method: 'GET',
        url: '/v1/customer/me/data-exports/018f0000-0000-7000-8000-000000000001',
        headers: c,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await http.inject({ method: 'GET', url: '/v1/admin/erasure-requests', headers: a }))
      .statusCode,
  ).toBe(403);
});
