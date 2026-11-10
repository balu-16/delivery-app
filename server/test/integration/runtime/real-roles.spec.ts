import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { surfacesFor } from '../../../src/app-roles/roles.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { PLATFORM_REDIS } from '../../../src/platform/contracts/runtime.js';
import type { Redis } from 'ioredis';

let services: TestServices;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
}, 120000);
afterAll(async () => {
  await services?.stop();
}, 120000);

it.each(['all', 'customer', 'rider', 'store', 'admin', 'worker'] as const)(
  'boots %s with live dependency probes and isolates actual audience routes',
  async (role) => {
    const env = readEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ROLE: role,
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
    });
    const app = await createApplication(env);
    try {
      const server = app.getHttpAdapter().getInstance();
      expect((await server.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      for (const surface of surfacesFor(role)) {
        const doc = (
          await server.inject({ method: 'GET', url: `/v1/${surface}/docs-json` })
        ).json();
        expect(doc.openapi).toBe('3.1.0');
        expect(Object.keys(doc.paths).every((path) => path.startsWith(`/v1/${surface}/`))).toBe(
          true,
        );
        expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
        if (surface === 'customer') {
          expect(doc.paths['/v1/customer/addresses']).toBeDefined();
          expect(doc.components.schemas.ServiceabilityView.properties.storeId.type).toEqual([
            'string',
            'null',
          ]);
          expect(doc.components.schemas.ServiceabilityView.properties.zone.anyOf).toEqual([
            { $ref: '#/components/schemas/ZoneView' },
            { type: 'null' },
          ]);
        }
        if (surface === 'store') expect(doc.paths['/v1/store/status']).toBeDefined();
        if (surface === 'admin') expect(doc.paths['/v1/admin/zones']).toBeDefined();
        await expect(SwaggerParser.validate(doc)).resolves.toBeDefined();
      }
      const cases = [
        { surface: 'customer' as const, method: 'GET' as const, url: '/v1/customer/me' },
        { surface: 'rider' as const, method: 'GET' as const, url: '/v1/rider/me' },
        { surface: 'store' as const, method: 'GET' as const, url: '/v1/store/me' },
        { surface: 'admin' as const, method: 'POST' as const, url: '/v1/admin/users/workforce' },
        { surface: 'customer' as const, method: 'GET' as const, url: '/v1/customer/addresses' },
        { surface: 'store' as const, method: 'POST' as const, url: '/v1/store/status' },
        { surface: 'admin' as const, method: 'POST' as const, url: '/v1/admin/zones' },
      ];
      for (const entry of cases) {
        const response = await server.inject({ method: entry.method, url: entry.url });
        expect(response.statusCode).toBe(surfacesFor(role).includes(entry.surface) ? 401 : 404);
      }
    } finally {
      await app.close();
    }
  },
  30000,
);

it('fails open for ordinary routes and closes location ingestion when Redis rate limits fail', async () => {
  const env = readEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ROLE: 'rider',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
  });
  const app = await createApplication(env);
  const redis = app.get<Redis>(PLATFORM_REDIS);
  const original = redis.eval;
  redis.eval = (() => Promise.reject(new Error('Redis unavailable'))) as typeof redis.eval;
  try {
    const server = app.getHttpAdapter().getInstance();
    expect((await server.inject({ method: 'GET', url: '/v1/rider/me' })).statusCode).toBe(401);
    const location = await server.inject({ method: 'POST', url: '/v1/rider/location' });
    expect(location.statusCode).toBe(503);
    expect(location.headers['retry-after']).toBe('5');
    expect(location.json().code).toBe('RATE_LIMIT_UNAVAILABLE');
  } finally {
    redis.eval = original;
    await app.close();
  }
}, 30000);
