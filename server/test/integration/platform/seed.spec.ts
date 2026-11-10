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
    const catalog = await client.query(
      'SELECT (SELECT count(*)::int FROM catalog_products) AS products,(SELECT count(*)::int FROM catalog_variants) AS variants,(SELECT count(*)::int FROM catalog_prices) AS prices,(SELECT count(*)::int FROM store_inventory WHERE on_hand=0 AND reserved=0) AS zero_stock',
    );
    expect(catalog.rows[0]).toEqual({ products: 200, variants: 200, prices: 600, zero_stock: 400 });
    const inventory = await client.query(
      "SELECT (SELECT count(*)::int FROM inventory_batches) AS batches,(SELECT count(*)::int FROM inventory_ledger WHERE kind='RECEIPT') AS receipts,(SELECT sum(on_hand)::text FROM store_inventory) AS on_hand,(SELECT sum(on_hand_delta)::text FROM inventory_ledger) AS ledger_total",
    );
    expect(inventory.rows[0]).toEqual({
      batches: 200,
      receipts: 200,
      on_hand: '4000',
      ledger_total: '4000',
    });
  } finally {
    await client.end();
  }
}, 30000);
