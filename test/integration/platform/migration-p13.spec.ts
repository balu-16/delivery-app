import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let client: Client;
const options = () => ({
  databaseUrl: services.databaseUrl,
  dir: resolve('db/migrations'),
  migrationsTable: 'pgmigrations',
  log: () => undefined,
});
beforeAll(async () => {
  services = await startTestServices();
  client = new Client({ connectionString: services.databaseUrl });
  await client.connect();
}, 120000);
afterAll(async () => {
  await client?.end();
  await services?.stop();
}, 120000);
it('upgrades populated P12 orders and refuses to roll back either forward-only P13 migration', async () => {
  await runner({ ...options(), direction: 'up', count: 27 });
  const user = uuidV7(),
    entity = uuidV7(),
    city = uuidV7(),
    store = uuidV7(),
    order = uuidV7();
  await client.query(
    `INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES($1::uuid,'CUSTOMER',$1::text,$2,'Migration')`,
    [user, `${user}@example.invalid`],
  );
  await client.query(`INSERT INTO legal_entities(id,name) VALUES($1,'entity')`, [entity]);
  await client.query(
    `INSERT INTO cities(id,name,bounds) VALUES($1,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`,
    [city],
  );
  await client.query(
    `INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES($1,$2,$3,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`,
    [store, entity, city],
  );
  await client.query(
    `INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at) VALUES($1,$2,$3,$4,'{}','CONFIRMED','PAID',100,100,100,clock_timestamp())`,
    [order, `ORD-${order.replaceAll('-', '').toUpperCase()}`, user, store],
  );
  await runner({ ...options(), direction: 'up', count: 1 });
  await expect(runner({ ...options(), direction: 'down', count: 1 })).rejects.toThrow(
    'migration 029 is forward-only',
  );
  await runner({ ...options(), direction: 'up', count: 1 });
  await expect(runner({ ...options(), direction: 'down', count: 1 })).rejects.toThrow(
    'migration 030 is forward-only',
  );
  expect(
    (
      await client.query('SELECT status,total_paise::text AS total FROM orders WHERE id=$1', [
        order,
      ])
    ).rows[0],
  ).toEqual({ status: 'CONFIRMED', total: '100' });
  const history = await client.query<{ name: string }>(
    `SELECT name FROM pgmigrations WHERE name LIKE '029_%' OR name LIKE '030_%' ORDER BY name`,
  );
  expect(history.rows.map((row) => row.name)).toEqual([
    '029_p13_partition_privileges',
    '030_p13_quote_price_fingerprint',
  ]);
});
