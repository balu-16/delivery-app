import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { hashLocalPassword } from '../../../src/adapters/auth/local-admin-auth.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof createApplication>>;
let managerSub: string;
let managerEmail: string;
let managerStoreId: string;
let otherStoreId: string;
let adminSub: string;
let adminEmail: string;
const password = 'store-password-1';

function cookiesOf(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return raw ? [String(raw)] : [];
}

function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const found = cookiesOf(response).find((cookie) => cookie.startsWith('store_session='));
  if (!found) throw new Error('store_session cookie missing');
  return found.split(';')[0]!;
}

async function login(
  server: {
    inject: (
      options: unknown,
    ) => Promise<{ statusCode: number; json: () => unknown; headers: Record<string, unknown> }>;
  },
  email: string,
  secret: string,
) {
  return server.inject({
    method: 'POST',
    url: '/v1/store/auth/login',
    payload: { email, password: secret },
  });
}

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
  managerSub = 'store-portal-manager';
  managerEmail = 'store-manager@example.test';
  adminSub = 'store-portal-admin';
  adminEmail = 'store-admin@example.test';
  managerStoreId = uuidV7();
  otherStoreId = uuidV7();
  const managerId = uuidV7();
  const otherManagerId = uuidV7();
  const adminId = uuidV7();
  const entity = uuidV7();
  const city = uuidV7();
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${managerStoreId}::uuid,${entity}::uuid,${city}::uuid,'Home Store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10),
    (${otherStoreId}::uuid,${entity}::uuid,${city}::uuid,'Other Store',ST_SetSRID(ST_MakePoint(77.7,13.1),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${managerId}::uuid,'WORKFORCE',${managerSub},${managerEmail},'Store Manager',true),
    (${otherManagerId}::uuid,'WORKFORCE','store-portal-second','second-manager@example.test','Second Manager',true),
    (${adminId}::uuid,'WORKFORCE',${adminSub},${adminEmail},'Portal Admin',true)`.execute(db.db);
  await sql`INSERT INTO user_roles(user_id,role) VALUES
    (${managerId}::uuid,'STORE_MANAGER'),(${otherManagerId}::uuid,'STORE_MANAGER'),(${adminId}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES
    (${managerId}::uuid,${managerStoreId}::uuid,'STORE_MANAGER'),
    (${managerId}::uuid,${otherStoreId}::uuid,'STORE_MANAGER'),
    (${otherManagerId}::uuid,${otherStoreId}::uuid,'STORE_MANAGER')`.execute(db.db);
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified,password_hash) VALUES
    ('WORKFORCE',${managerSub},${managerSub},${managerEmail},'Store Manager',true,${await hashLocalPassword(password)}),
    ('WORKFORCE','store-portal-second','store-portal-second','second-manager@example.test','Second Manager',true,${await hashLocalPassword('second-password-1')}),
    ('WORKFORCE',${adminSub},${adminSub},${adminEmail},'Portal Admin',true,${await hashLocalPassword('admin-password-1')})`.execute(
    db.db,
  );
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'store',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_DEFAULT_PER_MIN: '1000',
    STORE_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
    STORE_SESSION_IDLE_SECONDS: '1800',
    STORE_SESSION_ABSOLUTE_SECONDS: '604800',
  });
  app = await createApplication(env);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
  await services?.stop();
}, 120_000);

it('logs a store manager in with assignments, bootstraps the session and logs out with CSRF enforcement', async () => {
  const server = app.getHttpAdapter().getInstance();
  const issued = await login(server, managerEmail, password);
  expect(issued.statusCode).toBe(200);
  const body = issued.json() as {
    status: string;
    manager: { role: string; email: string; stores: Array<{ storeId: string; role: string }> };
    csrfToken: string;
  };
  expect(body.status).toBe('AUTHENTICATED');
  expect(body.manager).toMatchObject({ role: 'STORE_MANAGER', email: managerEmail });
  expect(body.manager.stores.map((store) => store.storeId).sort()).toEqual(
    [managerStoreId, otherStoreId].sort(),
  );
  expect(body.csrfToken).toEqual(expect.any(String));
  const cookie = sessionCookieOf(issued);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  const session = await server.inject({
    method: 'GET',
    url: '/v1/store/auth/session',
    headers: { cookie },
  });
  expect(session.statusCode).toBe(200);
  expect((session.json() as { manager: { role: string } }).manager.role).toBe('STORE_MANAGER');
  // The session cookie also authorizes store portal reads.
  const me = await server.inject({
    method: 'GET',
    url: '/v1/store/me',
    headers: { cookie },
  });
  expect(me.statusCode).toBe(200);
  const badCsrf = await server.inject({
    method: 'POST',
    url: '/v1/store/auth/logout',
    payload: {},
    headers: { cookie, 'x-store-csrf': 'wrong-token' },
  });
  expect(badCsrf.statusCode).toBe(403);
  expect((badCsrf.json() as { code: string }).code).toBe('CSRF_TOKEN_INVALID');
  const hostileOrigin = await server.inject({
    method: 'POST',
    url: '/v1/store/auth/logout',
    payload: {},
    headers: { cookie, 'x-store-csrf': body.csrfToken, origin: 'https://evil.example' },
  });
  expect(hostileOrigin.statusCode).toBe(403);
  const out = await server.inject({
    method: 'POST',
    url: '/v1/store/auth/logout',
    payload: {},
    headers: { cookie, 'x-store-csrf': body.csrfToken },
  });
  expect(out.statusCode).toBe(200);
  expect(out.json()).toMatchObject({ status: 'LOGGED_OUT' });
  expect(sessionCookieOf(out)).toContain('Max-Age=0');
  const afterLogout = await server.inject({
    method: 'GET',
    url: '/v1/store/auth/session',
    headers: { cookie },
  });
  expect(afterLogout.statusCode).toBe(401);
  expect((afterLogout.json() as { code: string }).code).toBe('SESSION_EXPIRED');
});

it('rejects a store cookie mutation that omits the CSRF token', async () => {
  const server = app.getHttpAdapter().getInstance();
  const issued = await login(server, managerEmail, password);
  const cookie = sessionCookieOf(issued);
  const denied = await server.inject({
    method: 'POST',
    url: '/v1/store/status',
    payload: { storeId: managerStoreId, status: 'PAUSED', reason: 'csrf check' },
    headers: { cookie },
  });
  expect(denied.statusCode).toBe(403);
  expect((denied.json() as { code: string }).code).toBe('CSRF_TOKEN_INVALID');
});

it('answers login failures generically and rejects admin credentials on the store audience', async () => {
  const server = app.getHttpAdapter().getInstance();
  for (const attempt of [
    { email: managerEmail, password: 'wrong-password-1' },
    { email: 'nobody@example.test', password: 'whatever-long-1' },
  ]) {
    const response = await login(server, attempt.email, attempt.password);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');
  }
  // The super admin authenticates against the directory but is not a store
  // manager: the store audience rejects them outright.
  const adminAttempt = await login(server, adminEmail, 'admin-password-1');
  expect(adminAttempt.statusCode).toBe(403);
  expect((adminAttempt.json() as { code: string }).code).toBe('FORBIDDEN');
});

it('rejects conflicting credentials and keeps bearer access for store API clients', async () => {
  const server = app.getHttpAdapter().getInstance();
  const issued = await login(server, managerEmail, password);
  expect(issued.statusCode).toBe(200);
  const cookie = sessionCookieOf(issued);
  const storeBearer = await new LocalTokenAdapter('local-dev-only-change-me', db.db).issue(
    'WORKFORCE',
    managerSub,
    'store',
    'access',
  );
  const conflicting = await server.inject({
    method: 'GET',
    url: '/v1/store/me',
    headers: { cookie, authorization: `Bearer ${storeBearer}` },
  });
  expect(conflicting.statusCode).toBe(409);
  expect((conflicting.json() as { code: string }).code).toBe('CONFLICTING_CREDENTIALS');
  // Bearer-only access keeps working for existing store API clients.
  const bearerOnly = await server.inject({
    method: 'GET',
    url: '/v1/store/me',
    headers: { authorization: `Bearer ${storeBearer}` },
  });
  expect(bearerOnly.statusCode).toBe(200);
  // The admin bearer token never grants store-audience access.
  const adminBearer = await new LocalTokenAdapter('local-dev-only-change-me', db.db).issue(
    'WORKFORCE',
    adminSub,
    'store',
    'access',
  );
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/v1/store/me',
        headers: { authorization: `Bearer ${adminBearer}` },
      })
    ).statusCode,
  ).toBe(403);
});

it('expires unknown or malformed session cookies as SESSION_EXPIRED', async () => {
  const server = app.getHttpAdapter().getInstance();
  const response = await server.inject({
    method: 'GET',
    url: '/v1/store/auth/session',
    headers: { cookie: 'store_session=definitely-not-a-session' },
  });
  expect(response.statusCode).toBe(401);
  expect((response.json() as { code: string }).code).toBe('SESSION_EXPIRED');
});

it('revokes portal access when the store-manager role is removed mid-session', async () => {
  const server = app.getHttpAdapter().getInstance();
  const temporarySub = 'store-portal-temporary';
  const temporaryEmail = 'store-temporary@example.test';
  const userId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${userId}::uuid,'WORKFORCE',${temporarySub},${temporaryEmail},'Temporary Manager',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${userId}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES (${userId}::uuid,${managerStoreId}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified,password_hash) VALUES
    ('WORKFORCE',${temporarySub},${temporarySub},${temporaryEmail},'Temporary Manager',true,${await hashLocalPassword('temporary-pass-1')})`.execute(
    db.db,
  );
  const issued = await login(server, temporaryEmail, 'temporary-pass-1');
  expect(issued.statusCode).toBe(200);
  const cookie = sessionCookieOf(issued);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/v1/store/auth/session',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(200);
  await sql`DELETE FROM user_roles WHERE user_id=${userId}::uuid AND role='STORE_MANAGER'`.execute(
    db.db,
  );
  const revoked = await server.inject({
    method: 'GET',
    url: '/v1/store/auth/session',
    headers: { cookie },
  });
  expect(revoked.statusCode).toBe(403);
  expect((revoked.json() as { code: string }).code).toBe('FORBIDDEN');
});

it('runs the local forgot-password reset without account enumeration', async () => {
  const server = app.getHttpAdapter().getInstance();
  const sent = await server.inject({
    method: 'POST',
    url: '/v1/store/auth/forgot-password',
    payload: { email: 'nobody-else@example.test' },
  });
  expect(sent.statusCode).toBe(200);
  expect(sent.json()).toMatchObject({ status: 'SENT' });
  const confirm = await server.inject({
    method: 'POST',
    url: '/v1/store/auth/forgot-password/confirm',
    payload: {
      email: managerEmail,
      confirmationCode: '000000',
      newPassword: 'rotated-password-2',
    },
  });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json()).toMatchObject({ status: 'RESET' });
  const oldLogin = await login(server, managerEmail, password);
  expect(oldLogin.statusCode).toBe(401);
  const newLogin = await login(server, managerEmail, 'rotated-password-2');
  expect(newLogin.statusCode).toBe(200);
  await server.inject({
    method: 'POST',
    url: '/v1/store/auth/forgot-password/confirm',
    payload: {
      email: managerEmail,
      confirmationCode: '000000',
      newPassword: password,
    },
  });
});
