import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
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
const tableExists = async (name: string) =>
  (
    await client.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [
      `public.${name}`,
    ])
  ).rows[0]!.present;
/** Seeds the minimum P0-P4 rows a cart needs: user, store, product, price, stock. */
async function seedPriorSchema(): Promise<{ userId: string; storeId: string; variantId: string }> {
  const userId = '11111111-1111-4111-8111-111111111111';
  const storeId = '22222222-2222-4222-8222-222222222222';
  const variantId = '33333333-3333-4333-8333-333333333333';
  await client.query(
    `INSERT INTO users(id,pool,cognito_sub,normalized_email,name)
     VALUES ($1,'CUSTOMER','mig-p5','mig-p5@example.invalid','Migrator') ON CONFLICT DO NOTHING`,
    [userId],
  );
  await client.query(
    `INSERT INTO legal_entities(id,name) VALUES ('44444444-4444-4444-8444-444444444444','entity')
     ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO cities(id,name,bounds) VALUES ('55555555-5555-4555-8555-555555555555','city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))
     ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity)
     VALUES ($1,'44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','store',
     ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10) ON CONFLICT DO NOTHING`,
    [storeId],
  );
  await client.query(
    `INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default)
     VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'road','560001','name','+919876543210',
     ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)`,
    [userId],
  );
  await client.query(
    `INSERT INTO catalog_categories(id,name) VALUES ('66666666-6666-4666-8666-666666666666','Dairy')
     ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO catalog_products(id,category_id,name,normalized_name,published)
     VALUES ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','Milk','milk',true)
     ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO catalog_variants(id,product_id,name,sku)
     VALUES ($1,'77777777-7777-4777-8777-777777777777','One litre','MILK-1') ON CONFLICT DO NOTHING`,
    [variantId],
  );
  await client.query(
    `INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by)
     VALUES ('88888888-8888-4888-8888-888888888888',$1,$2,10000,12000,statement_timestamp(),$3)`,
    [storeId, variantId, userId],
  );
  await client.query(
    `INSERT INTO store_inventory(store_id,variant_id,on_hand) VALUES ($1,$2,10) ON CONFLICT DO NOTHING`,
    [storeId, variantId],
  );
  return { userId, storeId, variantId };
}
it('upgrades a populated 005 schema to 006, enforces P5 constraints, and survives a rollback round-trip', async () => {
  // Stop after 005 so the database is exactly the pre-P5 shape.
  await runner({ ...options(), direction: 'up', count: 5 });
  expect(await tableExists('carts')).toBe(false);
  expect(await tableExists('coupons')).toBe(false);
  const { userId, storeId, variantId } = await seedPriorSchema();
  const before = await client.query<{ revision: string }>(
    'SELECT revision::text FROM catalog_revision WHERE singleton',
  );
  // Upgrade only 006 on top of populated data.
  await runner({ ...options(), direction: 'up', count: 1 });
  for (const table of [
    'carts',
    'cart_items',
    'quote_snapshots',
    'coupons',
    'coupon_user_quota',
    'coupon_redemptions',
    'checkout_intents',
  ])
    expect(await tableExists(table)).toBe(true);
  // Carts work against pre-existing rows; the active-cart unique holds.
  await client.query(
    `INSERT INTO carts(id,user_id,address_id,store_id)
     VALUES ('99999999-9999-4999-8999-999999999999',$1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$2)`,
    [userId, storeId],
  );
  await expect(
    client.query(
      `INSERT INTO carts(id,user_id,address_id,store_id)
       VALUES ('aaaaaaa1-0000-4000-8000-000000000001',$1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$2)`,
      [userId, storeId],
    ),
  ).rejects.toThrow(/duplicate key|unique/i);
  await client.query(
    `INSERT INTO cart_items(cart_id,variant_id,quantity,unit_price_paise,mrp_paise,tax_rate_bps)
     VALUES ('99999999-9999-4999-8999-999999999999',$1,2,10000,12000,500)`,
    [variantId],
  );
  // Coupons enforce kind/value and normalized-code constraints.
  await client.query(
    `INSERT INTO coupons(id,code,kind,value,min_order_paise,created_by)
     VALUES ('bbbbbbb1-0000-4000-8000-000000000001','MIG10','PERCENT',1000,0,$1)`,
    [userId],
  );
  await expect(
    client.query(
      `INSERT INTO coupons(id,code,kind,value,min_order_paise,created_by)
       VALUES ('bbbbbbb2-0000-4000-8000-000000000002','MIGBAD','PERCENT',20000,0,$1)`,
      [userId],
    ),
  ).rejects.toThrow(/check constraint/i);
  await expect(
    client.query(
      `INSERT INTO coupons(id,code,kind,value,min_order_paise,created_by)
       VALUES ('bbbbbbb3-0000-4000-8000-000000000003','x','FLAT',1,0,$1)`,
      [userId],
    ),
  ).rejects.toThrow(/check constraint/i);
  await client.query(
    `INSERT INTO quote_snapshots(id,cart_id,cart_version,user_id,store_id,address_id,status,lines,fees,issues,
     subtotal_paise,total_paise,amount_due_paise,price_version,config_version,coupon_fingerprint,expires_at)
     VALUES ('ccccccc1-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999',1,$1,$2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ACTIVE','[]','[]','[]',
     20000,20000,20000,(SELECT revision FROM catalog_revision WHERE singleton),0,NULL,clock_timestamp()+interval '10 minutes')`,
    [userId, storeId],
  );
  await expect(
    client.query(
      `INSERT INTO quote_snapshots(id,cart_id,cart_version,user_id,store_id,address_id,status,lines,fees,issues,
       subtotal_paise,total_paise,amount_due_paise,price_version,config_version,coupon_fingerprint,expires_at)
       VALUES ('ccccccc2-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999',1,$1,$2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ACTIVE','[]','[]','[]',
       20000,20000,20000,(SELECT revision FROM catalog_revision WHERE singleton),0,NULL,clock_timestamp()+interval '10 minutes')`,
      [userId, storeId],
    ),
  ).rejects.toThrow(/quote_snapshots_cart_active_idx|unique/i);
  await client.query(
    `INSERT INTO checkout_intents(id,cart_id,cart_version,quote_id,state,expires_at)
     VALUES ('ddddddd1-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999',1,
     'ccccccc1-0000-4000-8000-000000000001','ISSUED',clock_timestamp()+interval '10 minutes')`,
  );
  await expect(
    client.query(
      `INSERT INTO checkout_intents(id,cart_id,cart_version,quote_id,state,expires_at)
       VALUES ('ddddddd2-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999',1,
       'ccccccc1-0000-4000-8000-000000000001','ISSUED',clock_timestamp()+interval '10 minutes')`,
    ),
  ).rejects.toThrow(/checkout_intents_cart_id_cart_version_key|unique/i);
  // One down step removes exactly the P5 objects and keeps prior data intact.
  await runner({ ...options(), direction: 'down', count: 1 });
  for (const table of [
    'checkout_intents',
    'coupon_redemptions',
    'coupon_user_quota',
    'coupons',
    'quote_snapshots',
    'cart_items',
    'carts',
  ])
    expect(await tableExists(table)).toBe(false);
  const kept = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM catalog_variants WHERE id=$1',
    [variantId],
  );
  expect(kept.rows[0]!.n).toBe('1');
  expect(
    (await client.query('SELECT revision::text FROM catalog_revision WHERE singleton')).rows[0]!
      .revision,
  ).toBe(before.rows[0]!.revision);
  // Reapplying 006 rebuilds the same schema over the populated database.
  await runner({ ...options(), direction: 'up', count: 1 });
  expect(await tableExists('carts')).toBe(true);
  expect(await tableExists('coupons')).toBe(true);
  const carts = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM carts WHERE user_id=$1',
    [userId],
  );
  expect(carts.rows[0]!.n).toBe('0');
  await client.query(
    `INSERT INTO carts(id,user_id,address_id,store_id)
     VALUES ('99999999-9999-4999-8999-999999999999',$1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$2)`,
    [userId, storeId],
  );
}, 120000);
it('migrating an empty database up through 006 leaves the P5 objects in place', async () => {
  const fresh = await startTestServices();
  try {
    const empty = new Client({ connectionString: fresh.databaseUrl });
    await empty.connect();
    try {
      await runner({
        databaseUrl: fresh.databaseUrl,
        dir: resolve('db/migrations'),
        migrationsTable: 'pgmigrations',
        log: () => undefined,
        direction: 'up',
        count: 6,
      });
      for (const table of ['carts', 'cart_items', 'quote_snapshots', 'coupons', 'checkout_intents'])
        expect(
          (await empty.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]))
            .rows[0]!.present,
        ).toBe(true);
      const history = await empty.query<{ n: string }>(
        'SELECT count(*)::int AS n FROM pgmigrations',
      );
      expect(history.rows[0]!.n).toBe(6);
    } finally {
      await empty.end();
    }
  } finally {
    await fresh.stop();
  }
}, 120000);
