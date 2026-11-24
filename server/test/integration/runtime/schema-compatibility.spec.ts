import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import { startTestServices } from '../../helpers/services.js';

test('blocks startup on schema 066 and is ready after the forward upgrade', async () => {
  const services = await startTestServices();
  const database = createDatabase(services.databaseUrl);
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let riderApp: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const dir = resolve('db/migrations');
    const count = (await readdir(dir)).filter(
      (file) => /^\d{3}_.+\.(sql|mjs)$/.test(file) && Number(file.slice(0, 3)) <= 66,
    ).length;
    const options = {
      databaseUrl: services.databaseUrl,
      dir,
      migrationsTable: 'pgmigrations',
      direction: 'up' as const,
      log: () => undefined,
    };
    await runner({ ...options, count });
    const category = randomUUID();
    const product = randomUUID();
    await sql`INSERT INTO catalog_categories(id,name) VALUES (${category},'Dairy')`.execute(
      database.db,
    );
    await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name)
      VALUES (${product},${category},'Existing milk','existing milk')`.execute(database.db);
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
    });
    await expect(createApplication(env)).rejects.toThrow('Apply pending migrations');
    await runner(options);
    app = await createApplication(env);
    const http = app.getHttpAdapter().getInstance();
    expect((await http.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const existing =
      await sql`SELECT name,image_revision FROM catalog_products WHERE id=${product}`.execute(
        database.db,
      );
    expect(existing.rows).toEqual([{ name: 'Existing milk', image_revision: '0' }]);

    const customer = randomUUID();
    const rider = randomUUID();
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified)
      VALUES (${customer},'CUSTOMER',${customer}::text,'customer@example.invalid','Customer',true),
      (${rider},'WORKFORCE',${rider}::text,'rider@example.invalid','Rider',true)`.execute(
      database.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES (${customer},'CUSTOMER'),(${rider},'RIDER')`.execute(
      database.db,
    );
    await sql`INSERT INTO customer_profiles(user_id) VALUES (${customer})`.execute(database.db);
    await sql`INSERT INTO rider_profiles(user_id) VALUES (${rider})`.execute(database.db);
    const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, database.db);
    const customerToken = await tokens.issue('CUSTOMER', customer, 'customer', 'access');
    for (const url of [
      '/v1/customer/catalog/preview',
      '/v1/customer/app-content',
      '/v1/customer/me/cover',
      '/v1/customer/referrals/history',
    ]) {
      const response = await http.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect([url, response.statusCode]).toEqual([url, 200]);
    }
    riderApp = await createApplication({ ...env, APP_ROLE: 'rider' });
    const riderToken = await tokens.issue('WORKFORCE', rider, 'rider', 'access');
    const onboarding = await riderApp
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/v1/rider/onboarding',
        headers: { authorization: `Bearer ${riderToken}` },
      });
    expect(onboarding.statusCode).toBe(200);

    await sql`ALTER TABLE rider_profiles DROP COLUMN review_required_documents`.execute(
      database.db,
    );
    expect((await http.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  } finally {
    await riderApp?.close();
    await app?.close();
    await database.close();
    await services.stop();
  }
}, 120_000);
