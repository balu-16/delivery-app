import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import { startTestServices, type TestServices } from '../../helpers/services.js';

const execute = promisify(execFile);
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

it('seeds repeatably in local mode and refuses production', async () => {
  const run = (nodeEnv: string) =>
    execute(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: services.databaseUrl,
        NODE_ENV: nodeEnv,
        AUTH_PROVIDER: 'local',
      },
      timeout: 15000,
    });
  await run('test');
  await run('test');
  await expect(run('production')).rejects.toBeDefined();
  const client = new Client({ connectionString: services.databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      users: number;
      superadmins: number;
      stores: number;
      zones: number;
    }>(
      "SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM user_roles WHERE role='SUPER_ADMIN') AS superadmins,(SELECT count(*)::int FROM stores) AS stores,(SELECT count(*)::int FROM zones) AS zones",
    );
    expect(result.rows[0]).toEqual({ users: 8, superadmins: 2, stores: 3, zones: 3 });
  } finally {
    await client.end();
  }
}, 30000);
