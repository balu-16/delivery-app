import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let client: Client;

beforeAll(async () => {
  services = await startTestServices(
    process.env.AWS_P13_INTEGRATION === 'yes' ? { skipAwsCache: true } : {},
  );
  client = new Client({ connectionString: services.databaseUrl });
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client?.end();
  await services?.stop();
}, 120_000);

it('upgrades existing carts and prices through migrations 060–062', async () => {
  const options = {
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up' as const,
    log: () => undefined,
  };
  const migrationFiles = (await readdir(options.dir)).filter((name) =>
    /^\d+.*\.(sql|mjs)$/.test(name),
  );
  const previousCount = migrationFiles.filter((name) => Number(name.slice(0, 3)) <= 59).length;
  await runner({ ...options, count: previousCount });
  expect(
    (await client.query('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1')).rows[0],
  ).toEqual({
    name: '059_wallet_adjustment_idempotency',
  });
  expect(
    (await client.query("SELECT to_regclass('public.catalog_global_prices') AS view")).rows[0],
  ).toEqual({ view: null });

  const [
    customer,
    secondCustomer,
    actor,
    entity,
    city,
    store,
    otherStore,
    address,
    category,
    product,
    variant,
    alreadyCorrect,
    ordinary,
    cart,
  ] = Array.from({ length: 14 }, randomUUID);
  await client.query(
    `INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
      ($1,'CUSTOMER','migration-customer','customer@example.invalid','customer'),
      ($2,'CUSTOMER','migration-other','other@example.invalid','other'),
      ($3,'WORKFORCE','migration-actor','actor@example.invalid','actor')`,
    [customer, secondCustomer, actor],
  );
  await client.query("INSERT INTO legal_entities(id,name) VALUES($1,'entity')", [entity]);
  await client.query(
    "INSERT INTO cities(id,name,bounds) VALUES($1,'city',ST_GeomFromText('POLYGON((76 11,79 11,79 14,76 14,76 11))',4326))",
    [city],
  );
  await client.query(
    `INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
      ($1,$3,$4,'east',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10),
      ($2,$3,$4,'west',ST_SetSRID(ST_MakePoint(76.5,11.5),4326)::geography,'ONLINE',10)`,
    [store, otherStore, entity, city],
  );
  await client.query(
    "INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES($1,$2,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)",
    [address, customer],
  );
  await client.query("INSERT INTO catalog_categories(id,name) VALUES($1,'Dairy')", [category]);
  await client.query(
    "INSERT INTO catalog_products(id,category_id,name,normalized_name,published) VALUES($1,$2,'Milk','milk',true)",
    [product, category],
  );
  await client.query(
    `INSERT INTO catalog_variants(id,product_id,name,sku) VALUES
      ($1,$4,'Test one','DD-TEST-001'), ($2,$4,'Test two','DD-TEST-002'),
      ($3,$4,'Ordinary','OTHER-001')`,
    [variant, alreadyCorrect, ordinary, product],
  );
  await client.query(
    `INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,valid_to,created_by) VALUES
      (gen_random_uuid(),$1,$3,3500,4000,clock_timestamp()-interval '2 days',NULL,$6),
      (gen_random_uuid(),$2,$3,3500,4000,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',$6),
      (gen_random_uuid(),$2,$3,4100,4100,clock_timestamp()+interval '1 day',NULL,$6),
      (gen_random_uuid(),$1,$4,3200,3200,clock_timestamp()-interval '1 day',NULL,$6),
      (gen_random_uuid(),$1,$5,8500,8500,clock_timestamp()-interval '1 day',NULL,$6)`,
    [store, otherStore, variant, alreadyCorrect, ordinary, actor],
  );
  await client.query('INSERT INTO carts(id,user_id,address_id,store_id) VALUES($1,$2,$3,$4)', [
    cart,
    customer,
    address,
    store,
  ]);
  await client.query(
    'INSERT INTO cart_items(cart_id,variant_id,quantity,unit_price_paise,mrp_paise,tax_rate_bps) VALUES($1,$2,1,3500,4000,0)',
    [cart, variant],
  );

  await runner(options);
  // Newer migrations above must not move this assertion: 060–062 applied in order.
  expect(
    (
      await client.query(
        "SELECT name FROM pgmigrations WHERE name LIKE '060\\_%' OR name LIKE '061\\_%' OR name LIKE '062\\_%' ORDER BY id",
      )
    ).rows.map((r) => r.name),
  ).toEqual([
    '060_address_free_cart_and_prices',
    '061_dairy_shared_prices',
    '062_global_price_lookup_index',
  ]);
  expect(
    (await client.query('SELECT address_id,store_id FROM carts WHERE id=$1', [cart])).rows[0],
  ).toEqual({
    address_id: address,
    store_id: store,
  });
  expect(
    (
      await client.query(
        'SELECT unit_price_paise::text AS price FROM cart_items WHERE cart_id=$1',
        [cart],
      )
    ).rows[0],
  ).toEqual({ price: '3500' });
  await client.query('INSERT INTO carts(id,user_id) VALUES($1,$2)', [randomUUID(), secondCustomer]);
  await expect(
    client.query('UPDATE carts SET store_id=$2 WHERE user_id=$1', [secondCustomer, store]),
  ).rejects.toMatchObject({ code: '23514' });

  expect(
    (
      await client.query(
        `SELECT v.sku,p.selling_paise::text AS selling,p.mrp_paise::text AS mrp
     FROM catalog_global_prices p JOIN catalog_variants v ON v.id=p.variant_id ORDER BY v.sku`,
      )
    ).rows,
  ).toEqual([
    { sku: 'DD-TEST-001', selling: '3900', mrp: '3900' },
    { sku: 'DD-TEST-002', selling: '3200', mrp: '3200' },
    { sku: 'OTHER-001', selling: '8500', mrp: '8500' },
  ]);
  const history = await client.query(
    `SELECT selling_paise::text AS selling,valid_to IS NOT NULL AS ended,
      valid_from > statement_timestamp() AS future
     FROM catalog_prices WHERE variant_id=$1 AND store_id=$2 ORDER BY valid_from`,
    [variant, otherStore],
  );
  expect(history.rows).toEqual([
    { selling: '3500', ended: true, future: false },
    { selling: '3900', ended: true, future: false },
    { selling: '4100', ended: false, future: true },
  ]);
  expect(
    (
      await client.query(
        "SELECT details->>'sku' AS sku FROM audit_log WHERE action='INITIAL_SHARED_PRICE'",
      )
    ).rows,
  ).toEqual([{ sku: 'DD-TEST-001' }]);
  expect(
    (
      await client.query(
        "SELECT indisvalid FROM pg_index WHERE indexrelid='catalog_prices_global_lookup_idx'::regclass",
      )
    ).rows[0],
  ).toEqual({ indisvalid: true });
  const runtime = await client.query(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='delivery_runtime') AS present",
  );
  if (runtime.rows[0].present) {
    expect(
      (
        await client.query(
          "SELECT has_table_privilege('delivery_runtime','catalog_global_prices','SELECT') AS allowed",
        )
      ).rows[0],
    ).toEqual({ allowed: true });
  }
  await runner(options);
  expect((await client.query('SELECT count(*)::int AS count FROM pgmigrations')).rows[0]).toEqual({
    count: migrationFiles.length,
  });
}, 300_000);
