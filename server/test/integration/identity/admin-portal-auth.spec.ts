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
let adminSub: string;
let adminEmail: string;
let supportSub: string;
const password = 'portal-password-1';

function cookiesOf(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return raw ? [String(raw)] : [];
}

function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const found = cookiesOf(response).find((cookie) => cookie.startsWith('admin_session='));
  if (!found) throw new Error('admin_session cookie missing');
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
    url: '/v1/admin/auth/login',
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
  adminSub = 'portal-admin';
  adminEmail = 'portal-admin@example.test';
  supportSub = 'portal-support';
  const adminId = uuidV7();
  const supportId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${adminId}::uuid,'WORKFORCE',${adminSub},${adminEmail},'Portal Admin',true),
    (${supportId}::uuid,'WORKFORCE',${supportSub},'portal-support@example.test','Portal Support',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES
    (${adminId}::uuid,'SUPER_ADMIN'),(${supportId}::uuid,'SUPPORT_AGENT')`.execute(db.db);
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified,password_hash) VALUES
    ('WORKFORCE',${adminSub},${adminSub},${adminEmail},'Portal Admin',true,${await hashLocalPassword(password)}),
    ('WORKFORCE',${supportSub},${supportSub},'portal-support@example.test','Portal Support',true,${await hashLocalPassword('support-password-1')})`.execute(
    db.db,
  );
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'admin',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_DEFAULT_PER_MIN: '1000',
    ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
    ADMIN_SESSION_IDLE_SECONDS: '28800',
    ADMIN_SESSION_ABSOLUTE_SECONDS: '604800',
  });
  app = await createApplication(env);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
  await services?.stop();
}, 120_000);

it('logs a super admin in, bootstraps the session and logs out with CSRF enforcement', async () => {
  const server = app.getHttpAdapter().getInstance();
  const issued = await login(server, adminEmail, password);
  expect(issued.statusCode).toBe(200);
  const body = issued.json() as {
    status: string;
    admin: { role: string; email: string };
    csrfToken: string;
  };
  expect(body.status).toBe('AUTHENTICATED');
  expect(body.admin).toMatchObject({ role: 'ADMIN', email: adminEmail });
  expect(body.csrfToken).toEqual(expect.any(String));
  const cookie = sessionCookieOf(issued);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  const session = await server.inject({
    method: 'GET',
    url: '/v1/admin/auth/session',
    headers: { cookie },
  });
  expect(session.statusCode).toBe(200);
  expect((session.json() as { admin: { role: string } }).admin.role).toBe('ADMIN');
  // The session cookie also authorizes admin portal reads.
  const search = await server.inject({
    method: 'GET',
    url: '/v1/admin/search?q=al',
    headers: { cookie },
  });
  expect(search.statusCode).toBe(200);
  const badCsrf = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/logout',
    payload: {},
    headers: { cookie, 'x-admin-csrf': 'wrong-token' },
  });
  expect(badCsrf.statusCode).toBe(403);
  expect((badCsrf.json() as { code: string }).code).toBe('CSRF_TOKEN_INVALID');
  const hostileOrigin = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/logout',
    payload: {},
    headers: { cookie, 'x-admin-csrf': body.csrfToken, origin: 'https://evil.example' },
  });
  expect(hostileOrigin.statusCode).toBe(403);
  const out = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/logout',
    payload: {},
    headers: { cookie, 'x-admin-csrf': body.csrfToken },
  });
  expect(out.statusCode).toBe(200);
  expect(out.json()).toMatchObject({ status: 'LOGGED_OUT' });
  expect(sessionCookieOf(out)).toContain('Max-Age=0');
  const afterLogout = await server.inject({
    method: 'GET',
    url: '/v1/admin/auth/session',
    headers: { cookie },
  });
  expect(afterLogout.statusCode).toBe(401);
  expect((afterLogout.json() as { code: string }).code).toBe('SESSION_EXPIRED');
});

it('answers login failures generically and never enumerates accounts', async () => {
  const server = app.getHttpAdapter().getInstance();
  for (const attempt of [
    { email: adminEmail, password: 'wrong-password-1' },
    { email: 'nobody@example.test', password: 'whatever-long-1' },
  ]) {
    const response = await login(server, attempt.email, attempt.password);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');
  }
});

it('rejects weak new passwords and unknown challenges', async () => {
  const server = app.getHttpAdapter().getInstance();
  const weak = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/challenge',
    payload: { challengeId: 'a'.repeat(32), newPassword: 'short' },
  });
  expect(weak.statusCode).toBe(400);
  const unknown = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/challenge',
    payload: { challengeId: 'b'.repeat(32), newPassword: 'long-enough-1' },
  });
  expect(unknown.statusCode).toBe(400);
  expect((unknown.json() as { code: string }).code).toBe('INVALID_CHALLENGE');
});

it('runs the local forgot-password reset without account enumeration', async () => {
  const server = app.getHttpAdapter().getInstance();
  const sent = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/forgot-password',
    payload: { email: 'nobody-else@example.test' },
  });
  expect(sent.statusCode).toBe(200);
  expect(sent.json()).toMatchObject({ status: 'SENT' });
  const confirm = await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/forgot-password/confirm',
    payload: {
      email: adminEmail,
      confirmationCode: '000000',
      newPassword: 'rotated-password-2',
    },
  });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json()).toMatchObject({ status: 'RESET' });
  const oldLogin = await login(server, adminEmail, password);
  expect(oldLogin.statusCode).toBe(401);
  const newLogin = await login(server, adminEmail, 'rotated-password-2');
  expect(newLogin.statusCode).toBe(200);
  await server.inject({
    method: 'POST',
    url: '/v1/admin/auth/forgot-password/confirm',
    payload: {
      email: adminEmail,
      confirmationCode: '000000',
      newPassword: password,
    },
  });
});

it('rejects conflicting credentials and non-super-admin cookies on shared routes', async () => {
  const server = app.getHttpAdapter().getInstance();
  const bearer = await new LocalTokenAdapter('local-dev-only-change-me', db.db).issue(
    'WORKFORCE',
    adminSub,
    'admin',
    'access',
  );
  const supportLogin = await login(server, 'portal-support@example.test', 'support-password-1');
  expect(supportLogin.statusCode).toBe(403);
  const adminLogin = await login(server, adminEmail, password);
  expect(adminLogin.statusCode).toBe(200);
  const cookie = sessionCookieOf(adminLogin);
  const conflicting = await server.inject({
    method: 'GET',
    url: '/v1/admin/search?q=al',
    headers: { cookie, authorization: `Bearer ${bearer}` },
  });
  expect(conflicting.statusCode).toBe(409);
  expect((conflicting.json() as { code: string }).code).toBe('CONFLICTING_CREDENTIALS');
  // Cookie sessions re-check SUPER_ADMIN on every request; the support agent
  // cannot reach a bearer-only route by presenting no cookie.
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/v1/admin/search?q=al',
        headers: { authorization: `Bearer ${bearer}` },
      })
    ).statusCode,
  ).toBe(403);
});

it('revokes portal access when the super-admin role is removed mid-session', async () => {
  const server = app.getHttpAdapter().getInstance();
  const temporarySub = 'portal-temporary';
  const temporaryEmail = 'portal-temporary@example.test';
  const userId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${userId}::uuid,'WORKFORCE',${temporarySub},${temporaryEmail},'Temporary Admin',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${userId}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified,password_hash) VALUES
    ('WORKFORCE',${temporarySub},${temporarySub},${temporaryEmail},'Temporary Admin',true,${await hashLocalPassword('temporary-pass-1')})`.execute(
    db.db,
  );
  const issued = await login(server, temporaryEmail, 'temporary-pass-1');
  expect(issued.statusCode).toBe(200);
  const cookie = sessionCookieOf(issued);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/v1/admin/auth/session',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(200);
  await sql`DELETE FROM user_roles WHERE user_id=${userId}::uuid AND role='SUPER_ADMIN'`.execute(
    db.db,
  );
  const revoked = await server.inject({
    method: 'GET',
    url: '/v1/admin/auth/session',
    headers: { cookie },
  });
  expect(revoked.statusCode).toBe(403);
  expect((revoked.json() as { code: string }).code).toBe('FORBIDDEN');
});

it('expires unknown or malformed session cookies as SESSION_EXPIRED', async () => {
  const server = app.getHttpAdapter().getInstance();
  const response = await server.inject({
    method: 'GET',
    url: '/v1/admin/auth/session',
    headers: { cookie: 'admin_session=definitely-not-a-session' },
  });
  expect(response.statusCode).toBe(401);
  expect((response.json() as { code: string }).code).toBe('SESSION_EXPIRED');
});
