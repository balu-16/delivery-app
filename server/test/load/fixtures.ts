import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createDatabase } from '../../src/platform/database/database.js';
import { LocalTokenAdapter } from '../../src/adapters/auth/local.js';
import { WalletPrimitives } from '../../src/modules/wallet/infrastructure/postgres-wallet.js';
import { WalletCreditService } from '../../src/modules/wallet/infrastructure/postgres-credits.js';
import { PostgresInventoryManagement } from '../../src/modules/inventory/infrastructure/management.js';
import { DatabaseIdentityAccess } from '../../src/modules/identity/infrastructure/identity-access.js';

// Dedicated throwaway local database only. Run migrations and scripts/seed.ts first.
async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.AUTH_PROVIDER !== 'local' ||
    process.env.LOAD_FIXTURES !== 'yes'
  )
    throw new Error('Requires local auth and LOAD_FIXTURES=yes on a dedicated test database');
  const url = process.env.DATABASE_URL,
    secret = process.env.LOCAL_JWT_SECRET;
  if (!url || !secret) throw new Error('DATABASE_URL and LOCAL_JWT_SECRET required');
  const db = createDatabase(url),
    client = new Client({ connectionString: url });
  await client.connect();
  try {
    const store = '01800000-0000-7000-8000-000000000011';
    const manager = (
      await client.query("SELECT id FROM users WHERE pool='WORKFORCE' AND cognito_sub='manager'")
    ).rows[0]?.id as string | undefined;
    if (!manager) throw new Error('Run scripts/seed.ts first');
    await client.query('UPDATE stores SET hourly_capacity=2000 WHERE id=$1', [store]);
    await client.query(
      'INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT $1,day,0,1440 FROM generate_series(0,6) day ON CONFLICT (store_id,weekday,start_minute) DO UPDATE SET end_minute=1440',
      [store],
    );
    await client.query(
      "INSERT INTO app_config(key,value) VALUES('storeBacklogPauseThreshold','20000'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=app_config.version+1",
    );
    await client.query(
      "INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true",
    );
    const credit = new WalletCreditService(new WalletPrimitives(db.db));
    const signer = new LocalTokenAdapter(secret, db.db);
    const customers: { id: string; addressId: string; token: string }[] = [],
      riders: { id: string; token: string }[] = [];
    for (let i = 0; i < 1300; i++) {
      const sub = `p13-customer-${i}`,
        id = uuidV7(),
        address = uuidV7();
      await client.query(
        "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'CUSTOMER',$2,$3,$2,true)",
        [id, sub, `${sub}@example.invalid`],
      );
      await client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'CUSTOMER')", [id]);
      await client.query('INSERT INTO customer_profiles(user_id) VALUES($1)', [id]);
      await client.query(
        "INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES($1,$2,'load road','560001','load','+919876543210',ST_SetSRID(ST_MakePoint(77.59,12.97),4326)::geography,true)",
        [address, id],
      );
      await credit.credit({
        userId: id,
        bucket: 'cash',
        amountPaise: '10000000',
        reason: 'TOPUP_CREDIT',
        refType: 'P13_FIXTURE',
        refId: `p13-funding-${i}`,
      });
      customers.push({
        id,
        addressId: address,
        token: await signer.issue('CUSTOMER', sub, 'customer', 'access', 86400),
      });
    }
    for (let i = 0; i < 100; i++) {
      const sub = `p13-rider-${i}`,
        id = uuidV7();
      await client.query(
        "INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES($1,'WORKFORCE',$2,$3,$2,true)",
        [id, sub, `${sub}@example.invalid`],
      );
      await client.query("INSERT INTO user_roles(user_id,role) VALUES($1,'RIDER')", [id]);
      await client.query(
        "INSERT INTO rider_profiles(user_id,status,home_store_id) VALUES($1,'APPROVED',$2)",
        [id, store],
      );
      riders.push({ id, token: await signer.issue('WORKFORCE', sub, 'rider', 'access', 86400) });
    }
    const inventory = new PostgresInventoryManagement(db.db, new DatabaseIdentityAccess(db.db));
    const variants = (
      await client.query("SELECT id FROM catalog_variants WHERE sku LIKE 'LOCAL-%' ORDER BY sku")
    ).rows as { id: string }[];
    if (variants.length !== 200) throw new Error('Expected 200 seeded variants');
    for (const variant of variants)
      await inventory.receive(manager, {
        storeId: store,
        variantId: variant.id,
        batchCode: 'P13-LOAD',
        quantity: '1000',
        expiresAt: '2036-01-01T00:00:00.000Z',
        reference: `p13-opening:${variant.id}`,
      });
    const path = process.env.LOAD_FIXTURE_FILE ?? 'artifacts/p13-load/fixtures.json';
    await writeFile(
      path,
      JSON.stringify({ store, variants: variants.map((v) => v.id), customers, riders }),
      { mode: 0o600, flag: 'wx' },
    );
    process.stdout.write(
      `Created 1300 funded customers, 100 riders and receipt-backed stock; credentials in ${path}\n`,
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
