import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices, client: Client;
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

it('upgrades populated P6-P9 tables through the integrity repairs and round-trips repair migrations', async () => {
  await runner({ ...options(), direction: 'up', count: 10 });
  const user = uuidV7(),
    store = uuidV7(),
    entity = uuidV7(),
    city = uuidV7(),
    order = uuidV7(),
    task = uuidV7(),
    attempt = uuidV7(),
    capture = 'pay_' + uuidV7(),
    cod = uuidV7(),
    webhook = uuidV7();
  await client.query(
    "INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES($1::uuid,'WORKFORCE',$1::text,$2,'migration')",
    [user, user + '@example.invalid'],
  );
  await client.query("INSERT INTO legal_entities(id,name) VALUES($1,'entity')", [entity]);
  await client.query(
    "INSERT INTO cities(id,name,bounds) VALUES($1,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))",
    [city],
  );
  await client.query(
    "INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES($1,$2,$3,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',100)",
    [store, entity, city],
  );
  await client.query(
    "INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,total_paise,amount_due_paise,placed_at) VALUES($1,$2,$3,$4,'{}','CONFIRMED','PAID','GATEWAY',100,100,100,clock_timestamp())",
    [order, 'ORD-' + order.replaceAll('-', '').toUpperCase(), user, store],
  );
  await client.query(
    "INSERT INTO pick_tasks(id,order_id,store_id,status,assigned_to,sla_due_at) VALUES($1,$2,$3,'ASSIGNED',$4,clock_timestamp()+interval '30 minutes')",
    [task, order, store, user],
  );
  await client.query(
    "INSERT INTO payment_attempts(id,aggregate_id,order_id,kind,operation_reference,gateway,gateway_order_id,gateway_payment_id,amount_paise,currency,status) VALUES($1,$2,$2,'ORDER_PAYMENT',$3,'fake',$4,$5,100,'INR','CAPTURED')",
    [attempt, order, 'order-' + attempt.replaceAll('-', ''), 'gw_' + attempt, capture],
  );
  await client.query('INSERT INTO cod_collections(id,order_id,amount_paise) VALUES($1,$2,100)', [
    cod,
    order,
  ]);
  await client.query(
    "INSERT INTO gateway_event_inbox(id,gateway,gateway_event_id,body,body_hash,signature,signature_valid,state) VALUES($1,'fake',$2,'{}',$3,'invalid',false,'PENDING')",
    [webhook, webhook, '0'.repeat(64)],
  );
  await runner({ ...options(), direction: 'up', count: 17 });
  const migrated = await client.query<{
    gateway_payment_id: string;
    expected: string;
    state: string;
  }>(
    'SELECT c.gateway_payment_id,d.expected_amount_paise::text AS expected,w.state FROM payment_capture_receipts c JOIN cod_collections d ON d.order_id=c.order_id CROSS JOIN gateway_event_inbox w WHERE c.attempt_id=$1 AND w.id=$2',
    [attempt, webhook],
  );
  expect(migrated.rows).toEqual([
    { gateway_payment_id: capture, expected: '100', state: 'QUARANTINED' },
  ]);
  // The retained assignee and started-at history must survive task completion.
  await client.query(
    "UPDATE pick_tasks SET status='COMPLETED',started_at=clock_timestamp(),completed_at=clock_timestamp(),completed_by=$2 WHERE id=$1",
    [task, user],
  );
  const all = (await readdir(resolve('db/migrations'))).filter((name) => /^\d+.*\.sql$/.test(name));
  // 013 retains delivery history and deliberately forbids down migration.
  const repairs = all.filter(
    (name) => Number(name.slice(0, 3)) > 13 && Number(name.slice(0, 3)) <= 28,
  ).length;
  await runner({ ...options(), direction: 'down', count: repairs });
  expect(
    (await client.query('SELECT status,assigned_to FROM pick_tasks WHERE id=$1', [task])).rows[0],
  ).toEqual({ status: 'COMPLETED', assigned_to: user });
  await expect(runner({ ...options(), direction: 'down', count: 1 })).rejects.toThrow(
    'disabled down migration',
  );
  await runner({ ...options(), direction: 'up' });
  expect(
    (
      await client.query(
        'SELECT gateway_payment_id FROM payment_capture_receipts WHERE attempt_id=$1',
        [attempt],
      )
    ).rows[0]?.gateway_payment_id,
  ).toBe(capture);
  expect(
    (
      await client.query(
        'SELECT expected_amount_paise::text AS expected FROM cod_collections WHERE id=$1',
        [cod],
      )
    ).rows[0]?.expected,
  ).toBe('100');
});
