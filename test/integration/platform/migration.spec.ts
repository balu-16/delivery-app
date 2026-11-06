import { resolve } from 'node:path';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let client: Client;
beforeAll(async () => {
  services = await startTestServices();
  client = new Client({ connectionString: services.databaseUrl });
  await client.connect();
}, 120000);
afterAll(async () => {
  await client?.end();
  await services?.stop();
}, 120000);

it('upgrades an empty then populated previous schema, and reapplies a development rollback', async () => {
  const options = {
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  };
  await runner({ ...options, direction: 'up', count: 1 });
  await client.query(
    "INSERT INTO durable_operations(id,kind,reference,state) VALUES ('00000000-0000-4000-8000-000000000001','test','upgrade','new')",
  );
  await runner({ ...options, direction: 'up' });
  expect(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM durable_operations WHERE reference='upgrade'",
      )
    ).rows[0]?.count,
  ).toBe(1);
  const history = await client.query('SELECT count(*)::int AS count FROM pgmigrations');
  expect(history.rows[0]?.count).toBeGreaterThan(0);
  if (history.rows[0].count > 1) {
    await runner({ ...options, direction: 'down', count: 1 });
    await runner({ ...options, direction: 'up', count: 1 });
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM durable_operations WHERE reference='upgrade'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  }
});
