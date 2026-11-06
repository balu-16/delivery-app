import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: DatabaseHandle;
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
}, 120_000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120_000);

test('each identity operation rejects missing credentials, the wrong pool, and inappropriate workforce roles', async () => {
  const customer = uuidV7(),
    support = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${customer}::uuid,'CUSTOMER','matrix-customer','matrix-customer@test.invalid','Customer'),(${support}::uuid,'WORKFORCE','matrix-support','matrix-support@test.invalid','Support')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${customer}::uuid,'CUSTOMER'),(${support}::uuid,'SUPPORT_AGENT')`.execute(
    db.db,
  );
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    RATE_LIMIT_DEFAULT_PER_MIN: '10000',
    RATE_LIMIT_AUTH_PER_MIN: '10000',
  });
  const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
  const customerToken = await tokens.issue('CUSTOMER', 'matrix-customer', 'customer', 'access');
  const supportTokens = {
    admin: await tokens.issue('WORKFORCE', 'matrix-support', 'admin', 'access'),
    rider: await tokens.issue('WORKFORCE', 'matrix-support', 'rider', 'access'),
    store: await tokens.issue('WORKFORCE', 'matrix-support', 'store', 'access'),
  };
  const id = uuidV7();
  const routes: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    audience: 'customer' | 'rider' | 'store' | 'admin';
  }> = [
    { method: 'POST', url: '/v1/customer/auth/bootstrap', audience: 'customer' },
    { method: 'GET', url: '/v1/customer/me', audience: 'customer' },
    { method: 'PATCH', url: '/v1/customer/me', audience: 'customer' },
    { method: 'POST', url: '/v1/customer/me/consents', audience: 'customer' },
    { method: 'DELETE', url: '/v1/customer/me', audience: 'customer' },
    { method: 'GET', url: '/v1/rider/me', audience: 'rider' },
    { method: 'POST', url: '/v1/rider/onboarding/profile', audience: 'rider' },
    { method: 'POST', url: '/v1/rider/onboarding/documents/upload-url', audience: 'rider' },
    { method: 'POST', url: '/v1/rider/onboarding/documents', audience: 'rider' },
    { method: 'GET', url: '/v1/store/me', audience: 'store' },
    { method: 'GET', url: '/v1/admin/users', audience: 'admin' },
    { method: 'GET', url: '/v1/admin/config', audience: 'admin' },
    { method: 'POST', url: '/v1/admin/config/termsVersion', audience: 'admin' },
    { method: 'POST', url: '/v1/admin/feature-flags/wallet_enabled', audience: 'admin' },
    { method: 'GET', url: `/v1/admin/rider-documents/${id}/read-url`, audience: 'admin' },
    { method: 'POST', url: `/v1/admin/rider-documents/${id}/review`, audience: 'admin' },
    { method: 'POST', url: '/v1/admin/users/workforce', audience: 'admin' },
    { method: 'POST', url: `/v1/admin/users/${id}/block`, audience: 'admin' },
    { method: 'POST', url: `/v1/admin/users/${id}/password-reset`, audience: 'admin' },
    { method: 'POST', url: `/v1/admin/users/${id}/stores/${id}`, audience: 'admin' },
    { method: 'POST', url: `/v1/admin/users/${id}/roles/requests`, audience: 'admin' },
    { method: 'POST', url: `/v1/admin/role-change-requests/${id}/approve`, audience: 'admin' },
  ];
  const app = await createApplication(env);
  try {
    const server = app.getHttpAdapter().getInstance();
    for (const route of routes) {
      const missing = await server.inject({ method: route.method, url: route.url });
      expect([route.url, missing.statusCode]).toEqual([route.url, 401]);
      const wrong = route.audience === 'customer' ? supportTokens.admin : customerToken;
      const pool = await server.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${wrong}` },
      });
      expect([route.url, pool.statusCode]).toEqual([route.url, 401]);
      if (route.audience !== 'customer') {
        const role = await server.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: `Bearer ${supportTokens[route.audience]}` },
        });
        expect([route.url, role.statusCode]).toEqual([route.url, 403]);
      }
    }
  } finally {
    await app.close();
  }
});
