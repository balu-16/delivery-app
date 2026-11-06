import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { runner } from 'node-pg-migrate';
import request from 'supertest';
import { createApplication } from '../../src/bootstrap.js';
import { makeOpenApiDocument } from '../../src/common/http/openapi.js';
import { readEnv } from '../../src/config/env.schema.js';
import { startTestServices, type TestServices } from '../helpers/services.js';

const run = promisify(execFile);
let services: TestServices;
let app: NestFastifyApplication;
let privateDirectory: string;

beforeAll(async () => {
  services = await startTestServices();
  privateDirectory = await mkdtemp(join(tmpdir(), 'delivery-journey-'));
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
  const seedEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'local',
    DATABASE_URL: services.databaseUrl,
    LOCAL_CATALOG_STORAGE_DIR: join(privateDirectory, 'catalog'),
  };
  await run(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], { env: seedEnv });
  // A retry of the documented setup cannot duplicate seed roles, identities or stores.
  await run(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], { env: seedEnv });
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ROLE: 'all',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      LOCAL_PRIVATE_STORAGE_DIR: privateDirectory,
      LOCAL_CATALOG_STORAGE_DIR: join(privateDirectory, 'catalog'),
      RATE_LIMIT_DEFAULT_PER_MIN: '5000',
      RATE_LIMIT_AUTH_PER_MIN: '5000',
    }),
  );
}, 120000);

afterAll(async () => {
  await app?.close();
  await services?.stop();
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
}, 120000);

async function token(
  pool: string,
  sub: string,
  audience: string,
  tokenUse = 'access',
): Promise<string> {
  const result = await request(app.getHttpServer())
    .post('/dev/auth/token')
    .send({ pool, sub, audience, tokenUse })
    .expect(201);
  expect(typeof result.body.token).toBe('string');
  return result.body.token as string;
}

it('runs the seeded customer, store and admin journey through real HTTP adapters and services', async () => {
  const http = app.getHttpAdapter().getInstance();
  expect((await http.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  const customer = await token('CUSTOMER', 'customer', 'customer');
  const customerId = await token('CUSTOMER', 'customer', 'customer', 'id');
  const manager = await token('WORKFORCE', 'manager', 'store');
  const admin = await token('WORKFORCE', 'admin', 'admin');
  const headers = { authorization: `Bearer ${customer}` };
  const bootstrap = await http.inject({
    method: 'POST',
    url: '/v1/customer/auth/bootstrap',
    headers: { authorization: `Bearer ${customerId}` },
  });
  expect(bootstrap.statusCode).toBe(201);
  expect((await http.inject({ method: 'GET', url: '/v1/customer/me', headers })).statusCode).toBe(
    200,
  );
  const created = await http.inject({
    method: 'POST',
    url: '/v1/customer/addresses',
    headers,
    payload: {
      line1: 'Local test address',
      pincode: '560001',
      contactName: 'Local Customer',
      contactPhone: '+919876543210',
      lat: 12.97,
      lng: 77.59,
    },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().address.isDefault).toBe(true);
  const serviceable = await http.inject({
    method: 'GET',
    url: '/v1/customer/serviceability?lat=12.97&lng=77.59',
    headers,
  });
  expect(serviceable.statusCode).toBe(200);
  expect(serviceable.json()).toMatchObject({ serviceable: true, reasons: [] });
  const catalog = await http.inject({ method: 'GET', url: '/v1/customer/catalog/home', headers });
  expect(catalog.statusCode).toBe(200);
  expect(catalog.headers['cache-control']).toBe('private, no-cache');
  const items = catalog.json().items as Array<{
    availability: string;
    remaining?: string;
    images: string[];
  }>;
  expect(items.length).toBeGreaterThan(0);
  expect(items[0]?.availability).toBe('IN_STOCK');
  expect(items[0]).not.toHaveProperty('remaining');
  const unchanged = await http.inject({
    method: 'GET',
    url: '/v1/customer/catalog/home',
    headers: { ...headers, 'if-none-match': String(catalog.headers.etag) },
  });
  expect(unchanged.statusCode).toBe(304);
  const image = await http.inject({ method: 'GET', url: items[0]!.images[0]! });
  expect(image.statusCode).toBe(200);
  expect(image.headers['content-type']).toBe('image/png');
  const staff = await http.inject({
    method: 'GET',
    url: '/v1/store/me',
    headers: { authorization: `Bearer ${manager}` },
  });
  expect(staff.statusCode).toBe(200);
  expect(staff.json().stores).toHaveLength(1);
  expect(
    (
      await http.inject({
        method: 'GET',
        url: '/v1/admin/stores',
        headers: { authorization: `Bearer ${admin}` },
      })
    ).statusCode,
  ).toBe(200);
  expect((await http.inject({ method: 'GET', url: '/v1/admin/stores', headers })).statusCode).toBe(
    401,
  );
  const badAddress = await http.inject({
    method: 'POST',
    url: '/v1/customer/addresses',
    headers,
    payload: { ...created.json().address, unknownField: true },
  });
  expect(badAddress.statusCode).toBe(400);
});

it('requires authentication for every documented audience operation and documents request fields', async () => {
  const http = app.getHttpAdapter().getInstance();
  let operationCount = 0;
  for (const audience of ['customer', 'rider', 'store', 'admin'] as const) {
    const document = makeOpenApiDocument(app, audience);
    for (const [route, entry] of Object.entries(document.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        if (!entry?.[method]) continue;
        operationCount++;
        const response = await http.inject({
          method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: route.replace(/\{[^}]+\}/g, '01800000-0000-7000-8000-000000000011'),
        });
        expect({ method, route, status: response.statusCode }).toEqual({
          method,
          route,
          status: 401,
        });
      }
    }
    for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
      if (schema && 'type' in schema && schema.type === 'object' && /Dto$/.test(name)) {
        expect(Object.keys(schema.properties ?? {})).not.toHaveLength(0);
      }
    }
  }
  expect(operationCount).toBeGreaterThan(30);
});
