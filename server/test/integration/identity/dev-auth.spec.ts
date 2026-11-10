import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
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
}, 120_000);
afterAll(async () => {
  await services?.stop();
}, 120_000);
const body = { pool: 'CUSTOMER', sub: 'seeded-customer', audience: 'customer', tokenUse: 'access' };
it('issues only existing local identities and does not accept caller roles', async () => {
  const db = createDatabase(services.databaseUrl);
  const id = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${id}::uuid,'CUSTOMER',${body.sub},'dev-auth@example.test','Test')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${id}::uuid,'CUSTOMER')`.execute(db.db);
  await db.close();
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'customer',
    LOG_LEVEL: 'silent',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
  });
  const app = await createApplication(env);
  try {
    const server = app.getHttpAdapter().getInstance();
    const issued = await server.inject({ method: 'POST', url: '/dev/auth/token', payload: body });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().token).toEqual(expect.any(String));
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/dev/auth/token',
          payload: { ...body, sub: 'unknown' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/dev/auth/token',
          payload: { ...body, roles: ['SUPER_ADMIN'] },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
it.each(['production', 'cognito'] as const)(
  'cannot issue development tokens for %s',
  async (mode) => {
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
    });
    if (mode === 'production') env.NODE_ENV = 'production';
    else {
      env.AUTH_PROVIDER = 'cognito';
      env.COGNITO_CUSTOMER_POOL_ID = 'ap-south-1_test';
      env.COGNITO_CUSTOMER_CLIENT_ID = 'test';
    }
    const app = await createApplication(env);
    try {
      expect(
        (
          await app
            .getHttpAdapter()
            .getInstance()
            .inject({ method: 'POST', url: '/dev/auth/token', payload: body })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  },
);
