import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { runner } from 'node-pg-migrate';
import request from 'supertest';
import { SignJWT } from 'jose';
import { Client } from 'pg';
import { uuidV7 } from '../../src/common/ids/ids.js';
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
  const admin = await token('WORKFORCE', 'super-admin-1', 'admin');
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
  for (const suffix of ['', '/low-stock', '/expiring']) {
    const own = await http.inject({
      method: 'GET',
      url: `/v1/store/inventory${suffix}?storeId=01800000-0000-7000-8000-000000000011`,
      headers: { authorization: `Bearer ${manager}` },
    });
    expect(own.statusCode).toBe(200);
    const foreign = await http.inject({
      method: 'GET',
      url: `/v1/store/inventory${suffix}?storeId=01800000-0000-7000-8000-000000000012`,
      headers: { authorization: `Bearer ${manager}` },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('STORE_NOT_FOUND');
  }
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
  const nestedUnknown = await http.inject({
    method: 'PUT',
    url: '/v1/admin/stores/01800000-0000-7000-8000-000000000011/hours',
    headers: { authorization: `Bearer ${admin}` },
    payload: { entries: [{ weekday: 1, startMinute: 60, endMinute: 120, injected: 'canary' }] },
  });
  expect(nestedUnknown.statusCode).toBe(400);
  expect(nestedUnknown.body).not.toContain('canary');
  const rider = await token('WORKFORCE', 'rider', 'rider');
  const point = { ts: new Date().toISOString(), lat: 12.97, lng: 77.59 };
  const locationHeaders = { authorization: `Bearer ${rider}` };
  const invalidLocation = await http.inject({
    method: 'POST',
    url: '/v1/rider/location',
    headers: locationHeaders,
    payload: { points: [{ ...point, unexpected: 'canary' }] },
  });
  expect(invalidLocation.statusCode).toBe(400);
  expect(invalidLocation.body).not.toContain('canary');
  const offlineLocation = await http.inject({
    method: 'POST',
    url: '/v1/rider/location',
    headers: locationHeaders,
    payload: { points: [point] },
  });
  expect(offlineLocation.statusCode).toBe(409);
  expect(
    (
      await http.inject({
        method: 'POST',
        url: '/v1/rider/status/online',
        headers: locationHeaders,
      })
    ).statusCode,
  ).toBe(201);
  const validLocation = await http.inject({
    method: 'POST',
    url: '/v1/rider/location',
    headers: locationHeaders,
    payload: { points: [point] },
  });
  expect(validLocation.statusCode).toBe(201);
  const audiences = [
    { name: 'customer', access: customer },
    { name: 'rider', access: rider },
    { name: 'store', access: manager },
    { name: 'admin', access: admin },
  ];
  for (const audience of audiences) {
    const url = `/v1/${audience.name}/notification-preferences`;
    const headers = { authorization: `Bearer ${audience.access}` };
    const invalid = await http.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { updates: [{ category: 'PROMOTIONS', enabled: false, unexpected: 'canary' }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('canary');
    const valid = await http.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { updates: [{ category: 'PROMOTIONS', enabled: false }] },
    });
    expect(valid.statusCode).toBe(200);
  }
});

it('enrolls a rider through document rejection, resubmission and store-manager approval over HTTP', async () => {
  const http = app.getHttpAdapter().getInstance();
  const client = new Client({ connectionString: services.databaseUrl });
  await client.connect();
  try {
    const sub = uuidV7();
    await client.query(
      "INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified) VALUES('WORKFORCE',$1,$1,$2,'Test Rider',true)",
      [sub, `${sub}@example.test`],
    );
    const idToken = await token('WORKFORCE', sub, 'rider', 'id');
    const bootstrap = await http.inject({
      method: 'POST',
      url: '/v1/rider/auth/bootstrap',
      headers: { authorization: `Bearer ${idToken}` },
    });
    expect(bootstrap.statusCode).toBe(201);
    const userId = bootstrap.json().userId as string;
    expect(bootstrap.json().status).toBe('PENDING');
    const accessToken = await token('WORKFORCE', sub, 'rider');
    const headers = { authorization: `Bearer ${accessToken}` };
    expect(
      (await http.inject({ method: 'GET', url: '/v1/rider/status', headers })).statusCode,
    ).toBe(403);
    const storeId = '01800000-0000-7000-8000-000000000011';
    const stores = await http.inject({
      method: 'GET',
      url: '/v1/rider/onboarding/stores',
      headers,
    });
    expect(stores.statusCode).toBe(200);
    expect(stores.json().some((store: { id: string }) => store.id === storeId)).toBe(true);
    expect(
      (
        await http.inject({
          method: 'POST',
          url: '/v1/rider/onboarding/store',
          headers,
          payload: { storeId },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await http.inject({
          method: 'POST',
          url: '/v1/rider/onboarding/profile',
          headers,
          payload: { vehicleType: 'bike', vehicleNo: 'TEST-123' },
        })
      ).statusCode,
    ).toBe(201);

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    async function upload(type: string) {
      const target = await http.inject({
        method: 'POST',
        url: '/v1/rider/onboarding/documents/upload-url',
        headers,
        payload: { contentType: 'image/png', size: png.length },
      });
      expect(target.statusCode).toBe(201);
      const destination = target.json() as {
        mediaId: string;
        url: string;
        fields: { authorization: string };
      };
      const bytes = await http.inject({
        method: 'PUT',
        url: destination.url,
        headers: {
          authorization: destination.fields.authorization,
          'content-type': 'application/octet-stream',
        },
        payload: png,
      });
      expect(bytes.statusCode).toBe(200);
      const registered = await http.inject({
        method: 'POST',
        url: '/v1/rider/onboarding/documents',
        headers,
        payload: { documentType: type, mediaId: destination.mediaId },
      });
      expect(registered.statusCode).toBe(201);
    }
    for (const type of ['licence', 'vehicle_rc', 'id_proof', 'bank_proof']) await upload(type);
    const managerToken = await token('WORKFORCE', 'manager', 'store');
    const managerHeaders = { authorization: `Bearer ${managerToken}` };
    const queue = await http.inject({
      method: 'GET',
      url: `/v1/store/rider-applications?storeId=${storeId}&status=UNDER_REVIEW`,
      headers: managerHeaders,
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items.some((item: { userId: string }) => item.userId === userId)).toBe(
      true,
    );
    let detail = await http.inject({
      method: 'GET',
      url: `/v1/store/rider-applications/${userId}`,
      headers: managerHeaders,
    });
    let documents = detail.json().documents as { id: string; type: string; status: string }[];
    expect(
      (
        await http.inject({
          method: 'GET',
          url: `/v1/store/rider-documents/${documents[0]!.id}/read-url`,
          headers: managerHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await http.inject({
          method: 'POST',
          url: `/v1/store/rider-documents/${documents[0]!.id}/review`,
          headers: managerHeaders,
          payload: { approved: false, reason: 'Please upload a clearer image' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await http.inject({ method: 'GET', url: '/v1/rider/onboarding', headers })).json().status,
    ).toBe('REJECTED');
    await upload(documents[0]!.type);
    detail = await http.inject({
      method: 'GET',
      url: `/v1/store/rider-applications/${userId}`,
      headers: managerHeaders,
    });
    documents = detail.json().documents as typeof documents;
    for (const document of documents) {
      const review = await http.inject({
        method: 'POST',
        url: `/v1/store/rider-documents/${document.id}/review`,
        headers: managerHeaders,
        payload: { approved: true, reason: '' },
      });
      expect(review.statusCode).toBe(201);
    }
    expect(
      (await http.inject({ method: 'GET', url: '/v1/rider/onboarding', headers })).json().status,
    ).toBe('APPROVED');
    expect(
      (await http.inject({ method: 'GET', url: '/v1/rider/status', headers })).statusCode,
    ).toBe(200);
    expect(
      (await http.inject({ method: 'GET', url: '/v1/rider/tasks?scope=active', headers })).json()
        .items,
    ).toEqual([]);
  } finally {
    await client.end();
  }
});

it('rejects missing, expired, wrong-audience and wrong-role credentials for every guarded operation', async () => {
  const http = app.getHttpAdapter().getInstance();
  let operationCount = 0;
  const covered = new Set<string>();
  const customerToken = await token('CUSTOMER', 'customer', 'customer');
  const workforceToken = await token('WORKFORCE', 'super-admin-1', 'admin');
  const riderToken = await token('WORKFORCE', 'rider', 'rider');
  const wrongRoleTokens = {
    admin: await token('WORKFORCE', 'rider', 'admin'),
    rider: await token('WORKFORCE', 'support', 'rider'),
    store: await token('WORKFORCE', 'rider', 'store'),
  };
  const secret = new TextEncoder().encode(readEnv({ NODE_ENV: 'test' }).LOCAL_JWT_SECRET);
  const expiredCustomerId = await new SignJWT({ token_use: 'id' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('local:CUSTOMER')
    .setAudience('customer')
    .setSubject('customer')
    .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
    .sign(secret);
  const expiredRiderId = await new SignJWT({ token_use: 'id' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('local:WORKFORCE')
    .setAudience('rider')
    .setSubject('rider')
    .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
    .sign(secret);
  const expiredTokens = Object.fromEntries(
    await Promise.all(
      (['customer', 'rider', 'store', 'admin'] as const).map(
        async (audience) =>
          [
            audience,
            await new SignJWT({ token_use: 'access' })
              .setProtectedHeader({ alg: 'HS256' })
              .setIssuer(`local:${audience === 'customer' ? 'CUSTOMER' : 'WORKFORCE'}`)
              .setAudience(audience)
              .setSubject(audience === 'customer' ? 'customer' : 'rider')
              .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
              .sign(secret),
          ] as const,
      ),
    ),
  ) as Record<'customer' | 'rider' | 'store' | 'admin', string>;
  for (const audience of ['customer', 'rider', 'store', 'admin'] as const) {
    const document = makeOpenApiDocument(app, audience);
    for (const [route, entry] of Object.entries(document.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        if (!entry?.[method]) continue;
        if (entry[method]!.security?.length === 0) continue; // Public HMAC webhook has separate raw-byte/security tests.
        operationCount++;
        covered.add(`${method.toUpperCase()} ${route}`);
        const requestMethod = method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        const requestUrl = route.replace(/\{[^}]+\}/g, '01800000-0000-7000-8000-000000000011');
        const expired = await http.inject({
          method: requestMethod,
          url: requestUrl,
          headers: {
            authorization: `Bearer ${route === '/v1/customer/auth/bootstrap' ? expiredCustomerId : route === '/v1/rider/auth/bootstrap' ? expiredRiderId : expiredTokens[audience]}`,
          },
        });
        expect({ method, route, status: expired.statusCode }).toEqual({
          method,
          route,
          status: 401,
        });
        if (audience !== 'customer') {
          const wrongRole = await http.inject({
            method: requestMethod,
            url: requestUrl,
            headers: { authorization: `Bearer ${wrongRoleTokens[audience]}` },
          });
          expect({ method, route, status: wrongRole.statusCode }).toEqual({
            method,
            route,
            status: route === '/v1/rider/auth/bootstrap' ? 401 : 403,
          });
        }
        const response = await http.inject({
          method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: route.replace(/\{[^}]+\}/g, '01800000-0000-7000-8000-000000000011'),
        });
        expect({ method, route, status: response.statusCode }).toEqual({
          method,
          route,
          status: 401,
        });
        const wrongAudience = await http.inject({
          method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: route.replace(/\{[^}]+\}/g, '01800000-0000-7000-8000-000000000011'),
          headers: {
            authorization: `Bearer ${audience === 'customer' ? workforceToken : customerToken}`,
          },
        });
        expect({ method, route, status: wrongAudience.statusCode }).toEqual({
          method,
          route,
          status: 401,
        });
        if (audience !== 'customer') {
          const wrongWorkforceAudience = await http.inject({
            method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
            url: route.replace(/\{[^}]+\}/g, '01800000-0000-7000-8000-000000000011'),
            headers: {
              authorization: `Bearer ${audience === 'admin' ? riderToken : workforceToken}`,
            },
          });
          expect({ method, route, status: wrongWorkforceAudience.statusCode }).toEqual({
            method,
            route,
            status: 401,
          });
        }
      }
    }
    for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
      if (schema && 'type' in schema && schema.type === 'object' && /Dto$/.test(name)) {
        expect(Object.keys(schema.properties ?? {})).not.toHaveLength(0);
      }
    }
  }
  const manifest = JSON.parse(readFileSync('docs/manifests/operations.json', 'utf8')) as {
    items: Array<{ method: string; path: string; scope: string }>;
  };
  const expected = manifest.items
    .filter((item) => !item.scope.includes('gateway HMAC'))
    .map((item) => `${item.method} ${item.path}`)
    .sort();
  expect([...covered].sort()).toEqual(expected);
  expect(operationCount).toBe(expected.length);
  const cases = JSON.parse(readFileSync('test/security/operation-cases.json', 'utf8')) as {
    items: Array<{ method: string; path: string; authentication: { status: string } }>;
  };
  expect(cases.items.map((item) => `${item.method} ${item.path}`).sort()).toEqual(
    manifest.items.map((item) => `${item.method} ${item.path}`).sort(),
  );
  expect(
    cases.items
      .filter((item) => item.authentication.status === 'covered')
      .map((item) => `${item.method} ${item.path}`)
      .sort(),
  ).toEqual(expected);
});

it('rejects a correctly signed but expired customer access token', async () => {
  const env = readEnv({ NODE_ENV: 'test' });
  const expired = await new SignJWT({ token_use: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('local:CUSTOMER')
    .setAudience('customer')
    .setSubject('customer')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
    .sign(new TextEncoder().encode(env.LOCAL_JWT_SECRET));
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'GET',
      url: '/v1/customer/me',
      headers: { authorization: `Bearer ${expired}` },
    });
  expect(response.statusCode).toBe(401);
  expect(response.body).not.toContain(expired);
});

it('enforces default anonymous authentication and authenticated request limits with retry hints', async () => {
  const limitedApp = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ROLE: 'customer',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      LOCAL_PRIVATE_STORAGE_DIR: privateDirectory,
      LOCAL_CATALOG_STORAGE_DIR: join(privateDirectory, 'catalog'),
    }),
  );
  try {
    const http = limitedApp.getHttpAdapter().getInstance();
    const remoteAddress = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
    const send = () =>
      http.inject({
        method: 'POST',
        url: '/v1/customer/auth/bootstrap',
        remoteAddress,
      });
    for (let i = 0; i < 20; i++) expect((await send()).statusCode).toBe(401);
    const response = await send();
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('RATE_LIMITED');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    const db = new Client({ connectionString: services.databaseUrl });
    const userId = uuidV7();
    const sub = `ratelimit-${randomUUID()}`;
    await db.connect();
    try {
      await db.query(
        "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER',$2,$3,'Rate Limit',true)",
        [userId, sub, `${sub}@test.invalid`],
      );
      await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER')", [userId]);
      await db.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [userId]);
    } finally {
      await db.end();
    }
    const issued = await http.inject({
      method: 'POST',
      url: '/dev/auth/token',
      remoteAddress: `11.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`,
      payload: { pool: 'CUSTOMER', sub, audience: 'customer', tokenUse: 'access' },
    });
    expect(issued.statusCode).toBe(201);
    const bearer = issued.json().token as string;
    const authenticated = () =>
      http.inject({
        method: 'GET',
        url: '/v1/customer/me',
        remoteAddress,
        headers: { authorization: `Bearer ${bearer}` },
      });
    for (let i = 0; i < 120; i++) expect((await authenticated()).statusCode).toBe(200);
    const limited = await authenticated();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const searchBearer = await token('CUSTOMER', 'customer', 'customer');
    const search = () =>
      http.inject({
        method: 'GET',
        url: '/v1/customer/search?q=apple',
        remoteAddress,
        headers: { authorization: `Bearer ${searchBearer}` },
      });
    for (let i = 0; i < 30; i++) expect((await search()).statusCode).toBe(200);
    const searchLimited = await search();
    expect(searchLimited.statusCode).toBe(429);
    expect(Number(searchLimited.headers['retry-after'])).toBeGreaterThan(0);
  } finally {
    await limitedApp.close();
  }
});

it('global DTO validation rejects unknown top-level fields on typed body operations', async () => {
  // The exception factory exposes only validation field names to this test; production
  // retains the same whitelist settings and sends the sanitized problem response.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => new BadRequestException(errors),
  });
  const covered = new Set<string>();
  const liveCovered = new Set<string>();
  const credentials = {
    customer: await token('CUSTOMER', 'customer', 'customer'),
    rider: await token('WORKFORCE', 'rider', 'rider'),
    store: await token('WORKFORCE', 'manager', 'store'),
    admin: await token('WORKFORCE', 'super-admin-1', 'admin'),
  };
  const config = (app as unknown as { config: { getGlobalPipes(): unknown[] } }).config;
  const installed = config
    .getGlobalPipes()
    .find((entry) => entry instanceof ValidationPipe) as unknown as {
    validate(
      value: object,
      options: unknown,
    ): Promise<Array<{ property: string; constraints?: Record<string, string> }>>;
  };
  expect(installed).toBeDefined();
  const originalValidate = installed.validate;
  let validationErrors: Array<{ property: string; constraints?: Record<string, string> }> = [];
  installed.validate = async function (value, options) {
    const errors = await originalValidate.call(this, value, options);
    validationErrors.push(...errors);
    return errors;
  };
  const modules = app.get(ModulesContainer);
  try {
    for (const module of modules.values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        if (!controller) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
        if (typeof prefix !== 'string' || !prefix.startsWith('v1/')) continue;
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          if (name === 'constructor') continue;
          const handler = controller.prototype[name] as unknown;
          if (typeof handler !== 'function') continue;
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (typeof path !== 'string' || method === undefined) continue;
          const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) as
            Record<string, unknown> | undefined;
          const types = Reflect.getMetadata('design:paramtypes', controller.prototype, name) as
            Array<new (...args: never[]) => unknown> | undefined;
          for (const key of Object.keys(args ?? {})) {
            const [kind, index] = key.split(':').map(Number);
            if (kind !== 3 || index === undefined) continue;
            const metatype = types?.[index];
            if (
              !metatype ||
              [Object, String, Number, Boolean, Array, Buffer].includes(
                metatype as ObjectConstructor,
              )
            )
              continue;
            let exception: unknown;
            try {
              await pipe.transform({ __p13_unknown_field__: true }, { type: 'body', metatype });
            } catch (error) {
              exception = error;
            }
            expect(exception).toBeInstanceOf(BadRequestException);
            const response = (exception as BadRequestException).getResponse() as {
              message: Array<{ property: string; constraints?: Record<string, string> }>;
            };
            const errors = response.message;
            expect(
              errors.some(
                (error) =>
                  error.property === '__p13_unknown_field__' &&
                  error.constraints?.whitelistValidation,
              ),
            ).toBe(true);
            covered.add(
              `${RequestMethod[method]} /${[prefix, path].filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '')}`,
            );
            const route = `/${[prefix, path].filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '')}`;
            const audience = /^\/v1\/(customer|rider|store|admin)(?:\/|$)/.exec(route)?.[1] as
              keyof typeof credentials | undefined;
            const verb = RequestMethod[method];
            const param = (args?.[key] ?? {}) as { data?: unknown };
            if (
              audience &&
              !route.includes(':') &&
              ['POST', 'PUT', 'PATCH'].includes(verb) &&
              param.data === undefined
            ) {
              validationErrors = [];
              const result = await app
                .getHttpAdapter()
                .getInstance()
                .inject({
                  method: verb as 'POST' | 'PUT' | 'PATCH',
                  url: route,
                  headers: {
                    authorization: `Bearer ${credentials[audience]}`,
                    'idempotency-key': randomUUID(),
                  },
                  payload: { __p13_unknown_field__: true },
                });
              const rejectedUnknown = validationErrors.some(
                (error) =>
                  error.property === '__p13_unknown_field__' &&
                  error.constraints?.whitelistValidation,
              );
              if (rejectedUnknown) {
                expect(result.statusCode).toBe(400);
                liveCovered.add(`${verb} ${route}`);
              }
            }
          }
        }
      }
    }
  } finally {
    installed.validate = originalValidate;
  }
  expect(covered.size).toBeGreaterThan(0);
  expect(liveCovered.size).toBeGreaterThan(0);
  if (process.env.P13_DTO_EVIDENCE_FILE)
    writeFileSync(
      process.env.P13_DTO_EVIDENCE_FILE,
      JSON.stringify({ pipeOnly: [...covered].sort(), http: [...liveCovered].sort() }, null, 2),
    );
});
