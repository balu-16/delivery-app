import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
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
}, 120000);
afterAll(async () => {
  await services?.stop();
}, 120000);

it('worker startup catches up a due no-rider pause without another observation', async () => {
  const db = new Client({ connectionString: services.databaseUrl });
  await db.connect();
  const legal = uuidV7(),
    city = uuidV7(),
    store = uuidV7();
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    await db.query('INSERT INTO legal_entities(id,name) VALUES ($1,$2)', [legal, 'Test']);
    await db.query(
      'INSERT INTO cities(id,name,bounds) VALUES ($1,$2,ST_MakeEnvelope(77,12,78,14,4326))',
      [city, 'Test'],
    );
    await db.query(
      "INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES ($1,$2,$3,'Test',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,'ONLINE',10)",
      [store, legal, city],
    );
    await db.query(
      "INSERT INTO store_operational_signals(store_id,no_riders_since) VALUES ($1,clock_timestamp()-interval '1 hour')",
      [store],
    );
    app = await createApplication(
      readEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        APP_ROLE: 'worker',
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
      }),
    );
    const deadline = Date.now() + 5000;
    let status = '';
    while (Date.now() < deadline) {
      status =
        (await db.query<{ status: string }>('SELECT status FROM stores WHERE id=$1', [store]))
          .rows[0]?.status ?? '';
      if (status === 'PAUSED') break;
      await delay(50);
    }
    expect(status).toBe('PAUSED');
    expect(
      (
        await db.query<{ reason: string }>(
          'SELECT pause_reason AS reason FROM stores WHERE id=$1',
          [store],
        )
      ).rows[0]?.reason,
    ).toBe('AUTO_NO_RIDERS');
  } finally {
    await app?.close();
    await db.end();
  }
}, 30000);
