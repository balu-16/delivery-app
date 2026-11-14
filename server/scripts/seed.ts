import { Client } from 'pg';
import { databaseIamRegion, postgresConnectionConfig } from '../src/platform/database/database.js';
import { uuidV7 } from '../src/common/ids/ids.js';
import { seedCatalog } from './seed-catalog.js';
import { seedInventory } from './seed-inventory.js';
import { seedSubscriptions } from './seed-subscriptions.js';

// Sample data is local development data only. Re-running does not overwrite edits.
const users = [
  { sub: 'customer', pool: 'CUSTOMER', role: 'CUSTOMER' },
  { sub: 'rider', pool: 'WORKFORCE', role: 'RIDER' },
  { sub: 'manager', pool: 'WORKFORCE', role: 'STORE_MANAGER' },
  { sub: 'support', pool: 'WORKFORCE', role: 'SUPPORT_AGENT' },
  { sub: 'super-admin-1', pool: 'WORKFORCE', role: 'SUPER_ADMIN' },
  { sub: 'super-admin-2', pool: 'WORKFORCE', role: 'SUPER_ADMIN' },
] as const;
const legalId = '01800000-0000-7000-8000-000000000001';
const cityId = '01800000-0000-7000-8000-000000000002';
const stores = [
  {
    id: '01800000-0000-7000-8000-000000000011',
    zone: '01800000-0000-7000-8000-000000000021',
    name: 'Central',
    lng: 77.59,
    lat: 12.97,
  },
  {
    id: '01800000-0000-7000-8000-000000000012',
    zone: '01800000-0000-7000-8000-000000000022',
    name: 'South',
    lng: 77.62,
    lat: 12.92,
  },
  {
    id: '01800000-0000-7000-8000-000000000013',
    zone: '01800000-0000-7000-8000-000000000023',
    name: 'North',
    lng: 77.56,
    lat: 13.0,
  },
] as const;

// Local development coupons. Replay-safe: re-running never overwrites edits.
// One first-order-only, one percent-with-cap and one free-delivery fixture.
const coupons = [
  {
    code: 'FIRSTORDER200',
    kind: 'FLAT',
    valuePaise: '20000',
    maxCapPaise: null,
    minOrderPaise: '0',
    perUserLimit: 1,
    globalLimit: null,
    storeId: null,
    firstOrderOnly: true,
    stackable: false,
  },
  {
    code: 'SAVE20CAP100',
    kind: 'PERCENT',
    valuePaise: '2000',
    maxCapPaise: '10000',
    minOrderPaise: '29900',
    perUserLimit: null,
    globalLimit: null,
    storeId: null,
    firstOrderOnly: false,
    stackable: false,
  },
  {
    code: 'FREESHIP',
    kind: 'FREE_DELIVERY',
    valuePaise: '0',
    maxCapPaise: null,
    minOrderPaise: '0',
    perUserLimit: null,
    globalLimit: null,
    storeId: null,
    firstOrderOnly: false,
    stackable: false,
  },
] as const;
async function seedCoupons(client: Client): Promise<void> {
  const admin = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE pool='WORKFORCE' AND cognito_sub='super-admin-1' LIMIT 1",
  );
  const adminId = admin.rows[0]?.id;
  if (!adminId) throw new Error('Seed admin identity is required for coupons');
  for (const coupon of coupons) {
    await client.query(
      `INSERT INTO coupons(id,code,kind,value,max_cap_paise,min_order_paise,per_user_limit,global_limit,
        store_id,first_order_only,stackable,created_by)
       VALUES ($1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7,$8,$9::uuid,$10,$11,$12)
       ON CONFLICT (code) DO NOTHING`,
      [
        uuidV7(),
        coupon.code,
        coupon.kind,
        coupon.valuePaise,
        coupon.maxCapPaise,
        coupon.minOrderPaise,
        coupon.perUserLimit,
        coupon.globalLimit,
        coupon.storeId,
        coupon.firstOrderOnly,
        coupon.stackable,
        adminId,
      ],
    );
  }
}
async function main(): Promise<void> {
  if (process.env.STORAGE_PROVIDER === 's3')
    throw new Error('The development seed writes local images and cannot run with S3 storage');
  if (
    process.env.NODE_ENV === 'production' ||
    (process.env.AUTH_PROVIDER &&
      process.env.AUTH_PROVIDER !== 'local' &&
      !(
        process.env.SEED_AWS_DEVELOPMENT_FIXTURES === 'deliveryapp' &&
        process.env.DATABASE_AUTH === 'iam' &&
        process.env.DATABASE_URL &&
        new URL(process.env.DATABASE_URL).pathname === '/deliveryapp'
      ))
  )
    throw new Error('Seed data is available only with local authentication outside production');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const client = new Client({
    ...postgresConnectionConfig(connectionString, databaseIamRegion(process.env)),
    connectionTimeoutMillis: 60000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO legal_entities(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [legalId, 'Local Delivery'],
    );
    await client.query(
      'INSERT INTO cities(id,name,bounds) VALUES ($1,$2,ST_MakeEnvelope(77.45,12.80,77.80,13.15,4326)) ON CONFLICT DO NOTHING',
      [cityId, 'Bengaluru'],
    );
    for (const store of stores) {
      await client.query(
        "INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,'ONLINE',100) ON CONFLICT DO NOTHING",
        [store.id, legalId, cityId, store.name, store.lng, store.lat],
      );
      await client.query(
        'INSERT INTO zones(id,store_id,name,polygon,priority) VALUES ($1,$2,$3,ST_Multi(ST_MakeEnvelope($4::float8-0.02,$5::float8-0.02,$4::float8+0.02,$5::float8+0.02,4326)),$6) ON CONFLICT DO NOTHING',
        [
          store.zone,
          store.id,
          `${store.name} zone`,
          store.lng,
          store.lat,
          stores.indexOf(store) + 1,
        ],
      );
      await client.query(
        'INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT $1,day,0,1440 FROM generate_series(0,6) AS day ON CONFLICT DO NOTHING',
        [store.id],
      );
    }
    for (const user of users) {
      const email = `${user.sub}@example.test`;
      await client.query(
        'INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING',
        [uuidV7(), user.pool, user.sub, email, user.sub],
      );
      const result = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE pool=$1 AND cognito_sub=$2 AND normalized_email=$3',
        [user.pool, user.sub, email],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('Seed identity conflicts with existing data');
      await client.query(
        'INSERT INTO user_roles(user_id,role) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, user.role],
      );
      await client.query(
        'INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified) VALUES ($1,$2,$2,$3,$2,true) ON CONFLICT DO NOTHING',
        [user.pool, user.sub, email],
      );
      await client.query(
        'INSERT INTO local_identity_groups(pool,username,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [user.pool, user.sub, user.role],
      );
      if (user.pool === 'CUSTOMER')
        await client.query(
          'INSERT INTO customer_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [id],
        );
      else if (user.role === 'RIDER')
        await client.query(
          "INSERT INTO rider_profiles(user_id,status,home_store_id) VALUES ($1,'APPROVED',$2) ON CONFLICT DO NOTHING",
          [id, stores[0].id],
        );
      else
        await client.query(
          'INSERT INTO staff_profiles(user_id,employee_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, user.sub],
        );
      if (user.role === 'STORE_MANAGER')
        await client.query(
          'INSERT INTO store_staff(user_id,store_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [id, stores[0].id, user.role],
        );
    }
    await seedCatalog(
      client,
      stores.map((store) => store.id),
    );
    await seedCoupons(client);
    await seedSubscriptions(
      client,
      stores.map((store) => store.id),
    );
    await client.query('COMMIT');
    await seedInventory(client, stores[0].id, connectionString);
    process.stdout.write(
      'Seeded local identities, stores and 200 catalog products with receipt-backed stock in the first store.\n',
    );
    for (const user of users)
      process.stdout.write(`Local identity: ${user.pool} ${user.sub} (${user.role})\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
void main().catch((error: unknown) => {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z_]{1,24}$/.test(error.code)
      ? error.code
      : 'UNKNOWN';
  process.stderr.write(
    `Development seed failed (${code}); confirm migrations and local configuration.\n`,
  );
  process.exitCode = 1;
});
