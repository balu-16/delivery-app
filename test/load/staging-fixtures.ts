import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createDatabase } from '../../src/platform/database/database.js';
import { LocalTokenAdapter } from '../../src/adapters/auth/local.js';
import { WalletCreditService } from '../../src/modules/wallet/infrastructure/postgres-credits.js';
import { WalletPrimitives } from '../../src/modules/wallet/infrastructure/postgres-wallet.js';
import { PostgresInventoryManagement } from '../../src/modules/inventory/infrastructure/management.js';
import { DatabaseIdentityAccess } from '../../src/modules/identity/infrastructure/identity-access.js';

// Seed only a dedicated disposable, migrated DB after scripts/seed.ts. Counts are explicit.
async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.AUTH_PROVIDER !== 'local' ||
    process.env.LOAD_FIXTURES !== 'staging' ||
    process.env.LOAD_ISOLATED_DATABASE !== 'yes'
  )
    throw new Error('Requires local auth, LOAD_FIXTURES=staging, LOAD_ISOLATED_DATABASE=yes');
  const url = process.env.DATABASE_URL,
    secret = process.env.LOCAL_JWT_SECRET,
    path = process.env.LOAD_FIXTURE_FILE;
  if (!url || !secret || !path)
    throw new Error('DATABASE_URL, LOCAL_JWT_SECRET and LOAD_FIXTURE_FILE required');
  const count = (key: string, fallback: number) => {
    const n = Number(process.env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${key}`);
    return n;
  };
  const storesCount = count('LOAD_STORES', 100),
    skusCount = count('LOAD_SKUS_PER_STORE', 20000),
    customersCount = count('LOAD_CUSTOMERS', 18100),
    ridersCount = count('LOAD_RIDERS', 5000),
    stock = count('LOAD_STOCK_PER_SKU', 1000);
  const db = createDatabase(url, 20),
    client = new Client({ connectionString: url });
  await client.connect();
  try {
    const base = (
      await client.query(
        "SELECT s.legal_entity_id,s.city_id,u.id AS manager FROM stores s CROSS JOIN users u WHERE s.id='01800000-0000-7000-8000-000000000011' AND u.pool='WORKFORCE' AND u.cognito_sub='manager'",
      )
    ).rows[0];
    if (!base) throw new Error('Run scripts/seed.ts first');
    if (
      (await client.query("SELECT 1 FROM users WHERE cognito_sub LIKE 'p13-stage-%' LIMIT 1"))
        .rowCount
    )
      throw new Error('Staging fixture already exists; use a fresh database');
    const category = (await client.query('SELECT id FROM catalog_categories ORDER BY id LIMIT 1'))
      .rows[0]?.id;
    const locations: { id: string; lat: number; lng: number }[] = [];
    for (let i = 0; i < storesCount; i++) {
      const id = uuidV7(),
        lng = 77.46 + (i % 10) * 0.031,
        lat = 12.82 + Math.floor(i / 10) * 0.031;
      if (lat > 13.13) throw new Error('Maximum 100 staging stores supported');
      locations.push({ id, lat, lng });
      await client.query(
        "INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,'ONLINE',20000)",
        [id, base.legal_entity_id, base.city_id, `P13 staging ${i}`, lng, lat],
      );
      await client.query(
        'INSERT INTO zones(id,store_id,name,polygon,priority) VALUES($1,$2,$3,ST_Multi(ST_MakeEnvelope($4::float8-0.014,$5::float8-0.014,$4::float8+0.014,$5::float8+0.014,4326)),1000)',
        [uuidV7(), id, `P13 staging ${i}`, lng, lat],
      );
      await client.query(
        'INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT $1,day,0,1440 FROM generate_series(0,6) day',
        [id],
      );
      await client.query(
        "INSERT INTO store_staff(user_id,store_id,role) VALUES($1,$2,'STORE_MANAGER')",
        [base.manager, id],
      );
    }
    // Structural writes are batched. Every stock change uses the actual receipt service below.
    for (let first = 1; first <= skusCount; first += 500) {
      const last = Math.min(skusCount, first + 499);
      await client.query(
        `WITH product_rows AS (
        INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published)
        SELECT gen_random_uuid(),$1,'P13 staging milk '||n,'p13 staging milk '||n,'1001',500,true FROM generate_series($2::int,$3::int) n RETURNING id,name
      ) INSERT INTO catalog_variants(id,product_id,name,sku) SELECT gen_random_uuid(),id,'Unit',replace(name,'P13 staging milk ','P13-STAGE-') FROM product_rows`,
        [category, first, last],
      );
    }
    const variants = (
      await client.query(
        "SELECT id FROM catalog_variants WHERE sku LIKE 'P13-STAGE-%' ORDER BY sku",
      )
    ).rows as { id: string }[];
    if (variants.length !== skusCount) throw new Error('Unexpected SKU count');
    const inventory = new PostgresInventoryManagement(db.db, new DatabaseIdentityAccess(db.db));
    for (const store of locations) {
      for (let offset = 0; offset < variants.length; offset += 500) {
        const ids = variants.slice(offset, offset + 500).map((v) => v.id);
        await client.query(
          'INSERT INTO store_inventory(store_id,variant_id) SELECT $1,id FROM unnest($2::uuid[]) id',
          [store.id, ids],
        );
        await client.query(
          "INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) SELECT gen_random_uuid(),$1,id,10000,12000,'2020-01-01',$2 FROM unnest($3::uuid[]) id",
          [store.id, base.manager, ids],
        );
        for (const variant of ids)
          await inventory.receive(base.manager, {
            storeId: store.id,
            variantId: variant,
            batchCode: 'P13-STAGE',
            quantity: String(stock),
            reference: `p13-stage:${store.id}:${variant}`,
          });
      }
      process.stdout.write(
        `Receipt-backed store ${locations.indexOf(store) + 1}/${locations.length} complete\n`,
      );
    }
    await client.query(
      "INSERT INTO app_config(key,value) VALUES('storeBacklogPauseThreshold','20000'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=app_config.version+1",
    );
    await client.query(
      "INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true",
    );
    const credit = new WalletCreditService(new WalletPrimitives(db.db)),
      signer = new LocalTokenAdapter(secret, db.db);
    const customers: { id: string; addressId: string; token: string }[] = [],
      riders: { id: string; token: string }[] = [];
    for (let i = 0; i < customersCount; i++) {
      const sub = `p13-stage-customer-${i}`,
        id = uuidV7(),
        addressId = uuidV7(),
        location = locations[i % locations.length]!;
      await client.query(
        "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER',$2,$3,$2,true)",
        [id, sub, `${sub}@example.invalid`],
      );
      await client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER')", [id]);
      await client.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [id]);
      await client.query(
        "INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES($1,$2,'load road','560001','load','+919876543210',ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,true)",
        [addressId, id, location.lng, location.lat],
      );
      await credit.credit({
        userId: id,
        bucket: 'cash',
        amountPaise: '10000000',
        reason: 'TOPUP_CREDIT',
        refType: 'P13_FIXTURE',
        refId: `p13-stage-funding-${i}`,
      });
      customers.push({
        id,
        addressId,
        token: await signer.issue('CUSTOMER', sub, 'customer', 'access', 86400),
      });
    }
    for (let i = 0; i < ridersCount; i++) {
      const sub = `p13-stage-rider-${i}`,
        id = uuidV7(),
        location = locations[i % locations.length]!;
      await client.query(
        "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'WORKFORCE',$2,$3,$2,true)",
        [id, sub, `${sub}@example.invalid`],
      );
      await client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'RIDER')", [id]);
      await client.query(
        "INSERT INTO rider_profiles(user_id,status,home_store_id) VALUES($1,'APPROVED',$2)",
        [id, location.id],
      );
      riders.push({ id, token: await signer.issue('WORKFORCE', sub, 'rider', 'access', 86400) });
    }
    await writeFile(
      path,
      JSON.stringify({
        stores: locations,
        variants: variants.map((v) => v.id),
        customers,
        riders,
        configured: { storesCount, skusCount, customersCount, ridersCount, stock },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    process.stdout.write(
      `Staging fixture written to ${path}; verify counts, ledger invariants, and real serviceability before load.\n`,
    );
  } finally {
    await client.end();
    await db.close();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
