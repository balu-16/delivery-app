import { resolve } from 'node:path';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresAddresses } from '../../../src/modules/addresses/infrastructure/postgres-addresses.js';
import { resolveStoreForAddress } from '../../../src/modules/cart/infrastructure/cart-evaluation.js';
import { PostgresSupport } from '../../../src/modules/support/infrastructure/postgres-support.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import type { PrivateUploadPort } from '../../../src/modules/identity/contracts/uploads.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: DatabaseHandle;
const customer = uuidV7(),
  staff = uuidV7(),
  other = uuidV7(),
  category = uuidV7();
const names = [
  'full-cream milk',
  'toned milk',
  'A2 milk',
  'curd',
  'paneer',
  'butter',
  'ghee',
  'buttermilk',
  'sweet lassi',
  'yogurt',
];
const productIds = names.map(() => uuidV7());
const config = {
  get: async (key: string) =>
    ({
      supportMessageMaxLength: 2000,
      supportTicketCreationLimitPerHour: 10,
      supportFirstResponseSlaHours: 4,
      supportResolutionSlaHours: 24,
      supportReopenDays: 7,
    })[key as 'supportMessageMaxLength'],
} as unknown as AppConfig;

beforeAll(async () => {
  services = await startTestServices({ skipAwsCache: true });
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: 54,
    log: () => undefined,
  });
  db = createDatabase(
    services.databaseIamUrl ?? services.databaseUrl,
    4,
    30000,
    undefined,
    30000,
    services.databaseIamUrl ? process.env.AWS_REGION : undefined,
  );
  for (const [id, pool, role] of [
    [customer, 'CUSTOMER', 'CUSTOMER'],
    [other, 'CUSTOMER', 'CUSTOMER'],
    [staff, 'WORKFORCE', 'SUPER_ADMIN'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,${pool},${id},${`${id}@example.invalid`},'Synthetic')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,${role})`.execute(db.db);
  }
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Test Dairy')`.execute(
    db.db,
  );
  for (const [index, name] of names.entries()) {
    const original = `Test ${name}`;
    await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,description) VALUES(${productIds[index]}::uuid,${category}::uuid,${original},${original.toLowerCase()},'Test product for app checkout. Image is illustrative.')`.execute(
      db.db,
    );
    await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${uuidV7()}::uuid,${productIds[index]}::uuid,'test pack',${`DD-TEST-${String(index + 1).padStart(3, '0')}`})`.execute(
      db.db,
    );
  }
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: 1,
    log: () => undefined,
  });
  // Preserve the migration-056 catalogue check above, then bring the fixture up
  // to the current schema before exercising address and support services.
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
}, 300000);

afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

test('renames the ten seeded items and category without changing identifiers', async () => {
  const rows = await sql<{
    id: string;
    name: string;
    normalized_name: string;
    description: string;
  }>`SELECT id::text,name,normalized_name,description FROM catalog_products WHERE category_id=${category}::uuid ORDER BY id`.execute(
    db.db,
  );
  expect(rows.rows).toHaveLength(10);
  expect(new Set(rows.rows.map((row) => row.id))).toEqual(new Set(productIds));
  expect(
    rows.rows.every(
      (row) =>
        !/^test\b/i.test(row.name) &&
        row.normalized_name === row.name.toLowerCase() &&
        !row.description.toLowerCase().includes('test product'),
    ),
  ).toBe(true);
  const result = await sql<{
    name: string;
  }>`SELECT name FROM catalog_categories WHERE id=${category}::uuid`.execute(db.db);
  expect(result.rows[0]?.name).toBe('Dairy');
});

test('stores a written address once and refuses cart access when its PIN is not enabled', async () => {
  const repo = new PostgresAddresses(db.db);
  const written = {
    line1: '1 Example Street',
    pincode: '520001',
    contactName: 'Synthetic Customer',
    contactPhone: '+919876543210',
    point: null,
  };
  const [first, retry] = await Promise.all([
    repo.create(customer, written, 10, true, 'address-action'),
    repo.create(customer, written, 10, true, 'address-action'),
  ]);
  expect(first.id).toBe(retry.id);
  expect(first.point).toBeNull();
  await expect(resolveStoreForAddress(db.db, customer, first.id)).rejects.toThrow(
    'ADDRESS_NOT_SERVICEABLE',
  );
  await expect(resolveStoreForAddress(db.db, other, first.id)).rejects.toThrow('ADDRESS_NOT_FOUND');
  const point = { lat: 16.50547, lng: 80.64823 };
  const confirmed = await repo.update(customer, first.id, { ...written, point }, first.version);
  expect(confirmed.id).toBe(first.id);
  expect(confirmed.point).toEqual(point);
  const assistantRetry = await repo.create(
    customer,
    written,
    10,
    true,
    'agent-address:another-chat',
  );
  expect(assistantRetry.id).toBe(first.id);
  expect(assistantRetry.point).toEqual(point);
  const distinct = await repo.create(
    customer,
    { ...written, contactPhone: '+919876543211' },
    10,
    false,
    'agent-address:different-contact',
  );
  expect(distinct.id).not.toBe(first.id);
  await expect(
    repo.update(customer, first.id, { ...written, point }, first.version),
  ).rejects.toThrow('CONCURRENT_MODIFICATION');
});

test('records genuine support acknowledgement and status transitions exactly once', async () => {
  const support = new PostgresSupport(db.db, config, {} as PrivateUploadPort);
  const request = {
    category: 'General',
    body: 'Synthetic support request',
    reference: 'ticket-action',
  };
  const id = await support.create(customer, request);
  expect(await support.create(customer, request)).toBe(id);
  await expect(support.acknowledge(customer, id)).rejects.toThrow('FORBIDDEN');
  await Promise.all([support.acknowledge(staff, id), support.acknowledge(staff, id)]);
  await support.update(staff, id, { status: 'IN_PROGRESS' });
  await support.update(staff, id, { status: 'RESOLVED' });
  const detail = (await support.detail(customer, id, false)) as { progress: { type: string }[] };
  expect(detail.progress.map((event) => event.type)).toEqual([
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'RESOLVED',
  ]);
  await expect(support.detail(other, id, false)).rejects.toThrow('RESOURCE_NOT_FOUND');
});
