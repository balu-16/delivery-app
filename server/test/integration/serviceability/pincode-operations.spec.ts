import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresPincodeAdmin } from '../../../src/modules/serviceability/infrastructure/pincode-admin.js';
import { PostgresServiceability } from '../../../src/modules/serviceability/infrastructure/postgres-serviceability.js';
import { ServiceabilityQuery } from '../../../src/modules/serviceability/application/serviceability.js';
import { resolveStoreForAddress } from '../../../src/modules/cart/infrastructure/cart-evaluation.js';
import {
  PlaceOrderSaga,
  type PlaceDependencies,
} from '../../../src/modules/checkout/infrastructure/place-order.js';
import { PostgresRiderEarnings } from '../../../src/modules/riders/infrastructure/postgres-rider-earnings.js';
import { earningsDefaults } from '../../../src/modules/riders/domain/earnings.js';
import { PostgresPayouts } from '../../../src/modules/payouts/infrastructure/postgres-payouts.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { WalletPrimitives } from '../../../src/modules/wallet/infrastructure/postgres-wallet.js';
import { WalletCreditService } from '../../../src/modules/wallet/infrastructure/postgres-credits.js';
import { WalletAdjustmentService } from '../../../src/modules/wallet/infrastructure/wallet-adjustments.js';
import { PostgresAdjustments } from '../../../src/modules/inventory/infrastructure/adjustments.js';
import { ConfigService as AppConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import type { WalletSpender } from '../../../src/modules/wallet/contracts/wallet.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { assertDisposableAgentDatabase } from '../agent/disposable-database.js';

let services: TestServices,
  db: DatabaseHandle,
  adminPins: PostgresPincodeAdmin,
  service: ServiceabilityQuery;
const admin = uuidV7(),
  customer = uuidV7(),
  rider = uuidV7(),
  entity = uuidV7(),
  city = uuidV7(),
  store = uuidV7(),
  otherStore = uuidV7(),
  address = uuidV7();

beforeAll(async () => {
  services = await startTestServices({ skipAwsCache: true });
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(
    services.databaseIamUrl ?? services.databaseUrl,
    8,
    30000,
    undefined,
    30000,
    services.databaseIamUrl ? process.env.AWS_REGION : undefined,
  );
  await assertDisposableAgentDatabase(db.db);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    (${admin}::uuid,'WORKFORCE','pins-admin','pins-admin@example.invalid','Admin'),
    (${rider}::uuid,'WORKFORCE','pins-rider','pins-rider@example.invalid','Rider'),
    (${customer}::uuid,'CUSTOMER','pins-customer','pins-customer@example.invalid','Customer')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'SUPER_ADMIN'),(${rider}::uuid,'RIDER'),(${customer}::uuid,'CUSTOMER')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'Test entity')`.execute(
    db.db,
  );
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'Test city',ST_GeomFromText('POLYGON((80 15,81 15,81 17,80 17,80 15))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${store}::uuid,${entity}::uuid,${city}::uuid,'Store A',ST_SetSRID(ST_MakePoint(80.6,16.5),4326)::geography,'ONLINE',10),
    (${otherStore}::uuid,${entity}::uuid,${city}::uuid,'Store B',ST_SetSRID(ST_MakePoint(80.5,16.4),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${address}::uuid,${customer}::uuid,'Test street','520001','Customer','+919876543210',NULL,true)`.execute(
    db.db,
  );
  adminPins = new PostgresPincodeAdmin(db.db, new DatabaseIdentityAccess(db.db));
  service = new ServiceabilityQuery(
    new PostgresServiceability(
      db.db,
      'Asia/Kolkata',
      { isOpenAt: async () => true } as never,
      async () => false,
    ),
    async () => ({ minMinutes: 10, maxMinutes: 30 }),
  );
}, 300000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 300000);

test('admin PIN assignments control availability and owned carts without coordinates', async () => {
  await expect(adminPins.create(customer, ['520001'], store, '')).rejects.toThrow('FORBIDDEN');
  await expect(adminPins.create(admin, ['bad'], store, '')).rejects.toThrow('INVALID_PINCODE');
  await adminPins.create(admin, ['520001', '520002'], store, 'City');
  await expect(adminPins.create(admin, ['520003', '520001'], store, '')).rejects.toThrow(
    'PINCODE_EXISTS',
  );
  expect((await adminPins.list(admin)).some((item) => item.pincode === '520003')).toBe(false);
  expect(await resolveStoreForAddress(db.db, customer, address)).toBe(store);
  await expect(resolveStoreForAddress(db.db, rider, address)).rejects.toThrow('ADDRESS_NOT_FOUND');
  expect(await service.check({ pincode: '520001', targetTime: new Date() })).toMatchObject({
    serviceable: true,
    storeId: store,
    zone: { kind: 'PINCODE' },
  });
  const pin = (await adminPins.list(admin)).find((item) => item.pincode === '520001')!;
  await adminPins.update(admin, pin.id, {
    storeId: store,
    locality: 'City',
    active: false,
    version: pin.version,
  });
  expect((await service.check({ pincode: '520001', targetTime: new Date() })).serviceable).toBe(
    false,
  );
  await expect(resolveStoreForAddress(db.db, customer, address)).rejects.toThrow(
    'ADDRESS_NOT_SERVICEABLE',
  );
  await expect(
    adminPins.update(admin, pin.id, {
      storeId: otherStore,
      locality: 'City',
      active: true,
      version: pin.version,
    }),
  ).rejects.toThrow('CONCURRENT_MODIFICATION');
  const current = (await adminPins.list(admin)).find((item) => item.id === pin.id)!;
  await adminPins.update(admin, pin.id, {
    storeId: otherStore,
    locality: 'City',
    active: true,
    version: current.version,
  });
  expect(await resolveStoreForAddress(db.db, customer, address)).toBe(otherStore);
  expect((await service.check({ pincode: '520001', targetTime: new Date() })).storeId).toBe(
    otherStore,
  );
}, 120000);

test('PIN edits wait for the store lock before locking the PIN needed by checkout', async () => {
  let pin = (await adminPins.list(admin)).find((item) => item.pincode === '520002');
  if (!pin) {
    await adminPins.create(admin, ['520002'], store, 'City');
    pin = (await adminPins.list(admin)).find((item) => item.pincode === '520002')!;
  }
  let edit: Promise<void> | undefined;
  await db.db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM stores WHERE id=${store}::uuid FOR UPDATE`.execute(tx);
    edit = adminPins.update(admin, pin!.id, {
      storeId: store,
      locality: 'Updated',
      active: true,
      version: pin!.version,
    });
    void edit.catch(() => undefined);
    // Wait until the editor is blocked on the store lock, then emulate the
    // checkout transaction taking a shared lock on the PIN before commit.
    let waiting = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM stores WHERE id=%FOR SHARE%') AS waiting`.execute(
        db.db,
      );
      if (result.rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!waiting) throw new Error('PIN editor did not wait on the store lock');
    await sql`SET LOCAL lock_timeout='3s'`.execute(tx);
    await sql`SELECT id FROM delivery_pincodes WHERE id=${pin!.id}::uuid FOR SHARE`.execute(tx);
  });
  await edit;
  expect((await adminPins.list(admin)).find((item) => item.id === pin!.id)?.locality).toBe(
    'Updated',
  );
}, 120000);

test('GPS flag blocks placement without a saved location and PIN-only mode reaches serviceability', async () => {
  const existing = (await adminPins.list(admin)).find((item) => item.pincode === '520001');
  if (!existing) await adminPins.create(admin, ['520001'], otherStore, 'City');
  else if (!existing.active || existing.storeId !== otherStore)
    await adminPins.update(admin, existing.id, {
      storeId: otherStore,
      locality: existing.locality,
      active: true,
      version: existing.version,
    });
  const quoteId = uuidV7(),
    cartId = uuidV7();
  const deps = {
    db: db.db,
    quotes: {
      get: async () => ({
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        lines: [{}],
        cartId,
        cartVersion: 1,
        quoteId,
        addressId: address,
        storeId: otherStore,
      }),
      markConsumed: async () => {},
    },
    intents: { consume: async () => {} },
    serviceability: service,
    config: { get: async () => 900 },
    capacity: { claim: async () => 'AT_CAPACITY' },
  } as unknown as PlaceDependencies;
  const saga = new PlaceOrderSaga(deps);
  const input = {
    quoteId,
    intentId: uuidV7(),
    method: 'COD' as const,
    idempotencyOperationId: uuidV7(),
  };
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('customer_location_required',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    db.db,
  );
  await expect(
    db.db.transaction().execute((tx) => saga.place(customer, input, tx)),
  ).rejects.toThrow('ADDRESS_LOCATION_REQUIRED');
  await sql`UPDATE feature_flags SET enabled=false WHERE key='customer_location_required'`.execute(
    db.db,
  );
  await expect(
    db.db.transaction().execute((tx) => saga.place(customer, input, tx)),
  ).rejects.toThrow('ADDRESS_NOT_SERVICEABLE');
  await expect(
    db.db.transaction().execute((tx) => saga.place(customer, { ...input, method: 'GATEWAY' }, tx)),
  ).rejects.toThrow('ONLINE_PAYMENTS_NOT_READY');
}, 120000);

test('one admin can safely retry a wallet adjustment without creating a second ledger entry', async () => {
  const primitives = new WalletPrimitives(db.db);
  const credits = new WalletCreditService(primitives);
  const spender = { adjust: credits.adjust.bind(credits) } as unknown as WalletSpender;
  const adjustments = new WalletAdjustmentService(
    primitives,
    spender,
    (actions) => new MakerChecker(db.db, actions),
    db.db,
  );
  const input = {
    userId: customer,
    bucket: 'cash' as const,
    direction: 'CREDIT' as const,
    amountPaise: '5000',
    reason: 'Test credit',
  };
  const requests = await Promise.all(
    Array.from({ length: 3 }, () => adjustments.request(admin, input, 'same-wallet-request')),
  );
  expect(new Set(requests).size).toBe(1);
  await Promise.all(requests.map((id) => adjustments.approve(admin, id)));
  await expect(
    adjustments.request(admin, { ...input, amountPaise: '6000' }, 'same-wallet-request'),
  ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  const rows = await sql<{
    balance: string;
    count: string;
  }>`SELECT a.cash_balance_paise::text AS balance,(SELECT COUNT(*)::text FROM wallet_ledger l WHERE l.account_id=a.id AND l.reason='ADMIN_ADJUSTMENT') AS count FROM wallet_accounts a WHERE a.user_id=${customer}::uuid`.execute(
    db.db,
  );
  expect(rows.rows[0]).toEqual({ balance: '5000', count: '1' });
  const promo = { ...input, bucket: 'promo' as const, amountPaise: '3000' };
  const credit = await adjustments.request(admin, promo, 'promo-credit');
  await adjustments.approve(admin, credit);
  const debit = await adjustments.request(
    admin,
    { ...promo, direction: 'DEBIT', amountPaise: '1200' },
    'promo-debit',
  );
  await adjustments.approve(admin, debit);
  const promoRows = await sql<{
    balance: string;
    available: string;
    allocated: string;
  }>`SELECT a.promo_balance_paise::text AS balance,
    (SELECT COALESCE(SUM(l.remaining_paise),0)::text FROM wallet_promo_lots l WHERE l.account_id=a.id AND l.state='ACTIVE' AND (l.expires_at IS NULL OR l.expires_at>clock_timestamp())) AS available,
    (SELECT COALESCE(sum((e->>'amountPaise')::bigint),0)::text FROM wallet_ledger l CROSS JOIN LATERAL jsonb_array_elements(l.lot_allocations) e WHERE l.account_id=a.id AND l.reason='ADMIN_ADJUSTMENT' AND l.bucket='promo') AS allocated
    FROM wallet_accounts a WHERE a.user_id=${customer}::uuid`.execute(db.db);
  expect(promoRows.rows[0]).toEqual({ balance: '1800', available: '1800', allocated: '1200' });
  const excessive = await adjustments.request(
    admin,
    { ...promo, direction: 'DEBIT', amountPaise: '1900' },
    'promo-insufficient',
  );
  await expect(adjustments.approve(admin, excessive)).rejects.toThrow('WALLET_INSUFFICIENT');
  const expired = await adjustments.request(
    admin,
    { ...input, amountPaise: '700' },
    'expired-adjustment',
  );
  await sql`UPDATE maker_checker_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired}::uuid`.execute(
    db.db,
  );
  await expect(adjustments.approve(admin, expired)).rejects.toThrow('APPROVAL_EXPIRED');
  const afterExpired = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM wallet_ledger l JOIN wallet_accounts a ON a.id=l.account_id WHERE a.user_id=${customer}::uuid AND l.bucket='cash' AND l.reason='ADMIN_ADJUSTMENT'`.execute(
    db.db,
  );
  expect(afterExpired.rows[0]?.count).toBe('1');
}, 120000);

test('unknown distance pays base and a later reviewed distance is included in a separate payout', async () => {
  const order = uuidV7(),
    task = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,total_paise,amount_due_paise,placed_at)
    VALUES(${order}::uuid,'PINTEST-ORDER',${customer}::uuid,${otherStore}::uuid,'{}'::jsonb,'CONFIRMED','COD_PENDING','COD',0,0,0,clock_timestamp())`.execute(
    db.db,
  );
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status) VALUES(${task}::uuid,${order}::uuid,${otherStore}::uuid,${customer}::uuid,'UNASSIGNED')`.execute(
    db.db,
  );
  const earnings = new PostgresRiderEarnings(db.db, earningsDefaults());
  const base = await earnings.recordForTask({
    taskId: task,
    orderId: order,
    riderId: rider,
    distanceMetres: null,
    detentionMinutes: 10,
    tipPaise: '2000',
  });
  expect(base).toMatchObject({ distanceMetres: null, distancePending: true, totalPaise: '5500' });
  const payout = new PostgresPayouts(db.db, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
  const earning = (
    await sql<{
      id: string;
    }>`SELECT id::text FROM rider_earnings WHERE task_id=${task}::uuid`.execute(db.db)
  ).rows[0]!.id;
  const cuts = (
    await sql<{
      first: Date;
      second: Date;
    }>`SELECT (date_trunc('week',clock_timestamp() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')-interval '7 days' AS first,(date_trunc('week',clock_timestamp() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS second`.execute(
      db.db,
    )
  ).rows[0]!;
  await sql`UPDATE rider_earnings SET computed_at=${cuts.first}::timestamptz-interval '1 day' WHERE id=${earning}::uuid`.execute(
    db.db,
  );
  const first = await payout.draft(rider, cuts.first.toISOString());
  expect(first).toBeTruthy();
  const approval = await payout.requestApproval(admin, first!);
  await payout.approve(admin, approval);
  expect((await payout.pendingDistances(admin)).map((item) => item.earningId)).toContain(earning);
  await Promise.all([
    payout.reviewDistance(admin, earning, 1500, 'Confirmed by store'),
    payout.reviewDistance(admin, earning, 1500, 'Confirmed by store'),
  ]);
  await expect(payout.reviewDistance(admin, earning, 2500, 'Different')).rejects.toThrow(
    'DISTANCE_ALREADY_REVIEWED',
  );
  await sql`UPDATE rider_distance_adjustments SET created_at=${cuts.second}::timestamptz-interval '1 day' WHERE earning_id=${earning}::uuid`.execute(
    db.db,
  );
  const second = await payout.draft(rider, cuts.second.toISOString());
  expect(second).toBeTruthy();
  const secondApproval = await payout.requestApproval(admin, second!);
  await payout.approve(admin, secondApproval);
  const amounts = await sql<{
    gross: string;
  }>`SELECT gross_paise::text AS gross FROM rider_payouts WHERE id=ANY(${[first!, second!]}::uuid[]) ORDER BY gross_paise DESC`.execute(
    db.db,
  );
  expect(amounts.rows.map((row) => row.gross)).toEqual(['5500', '1600']);
  expect((await earnings.forRider(rider)).items[0]).toMatchObject({
    distanceMetres: 1500,
    distancePending: false,
    totalPaise: '7100',
  });
}, 120000);

test('admin stock corrections protect reservations and replay only once', async () => {
  const category = uuidV7(),
    product = uuidV7(),
    variant = uuidV7(),
    batch = uuidV7();
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Test dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published) VALUES(${product}::uuid,${category}::uuid,'Milk','milk','0401',0,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${variant}::uuid,${product}::uuid,'Bottle','PIN-TEST-MILK')`.execute(
    db.db,
  );
  await sql`INSERT INTO store_inventory(store_id,variant_id,on_hand,reserved) VALUES(${store}::uuid,${variant}::uuid,10,3)`.execute(
    db.db,
  );
  await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,state,on_hand,reserved) VALUES(${batch}::uuid,${store}::uuid,${variant}::uuid,'BATCH-1','ACTIVE',10,3)`.execute(
    db.db,
  );
  const service = new PostgresAdjustments(
    db.db,
    new DatabaseIdentityAccess(db.db),
    new AppConfigService(db.db),
    { create: (actions) => new MakerChecker(db.db, actions) },
  );
  const input = {
    storeId: store,
    variantId: variant,
    batchId: batch,
    counted: '8',
    expectedVersion: '1',
    reason: 'Counted the batch',
    reference: 'stock-correction-1',
  };
  expect((await service.batches(admin, store)).items[0]).toMatchObject({
    batchId: batch,
    onHand: '10',
    reserved: '3',
  });
  await expect(service.correct(customer, input)).rejects.toThrow('FORBIDDEN');
  await expect(
    service.correct(admin, { ...input, counted: '2', reference: 'below-reserved' }),
  ).rejects.toThrow('INVENTORY_RESERVED');
  await Promise.all([service.correct(admin, input), service.correct(admin, input)]);
  await expect(service.correct(admin, { ...input, counted: '7' })).rejects.toThrow(
    'IDEMPOTENCY_KEY_REUSED',
  );
  const result = await sql<{
    on_hand: string;
    reserved: string;
    count: string;
  }>`SELECT b.on_hand::text,b.reserved::text,(SELECT count(*)::text FROM inventory_ledger l WHERE l.batch_id=b.id AND l.kind='ADJUSTMENT') AS count FROM inventory_batches b WHERE b.id=${batch}::uuid`.execute(
    db.db,
  );
  expect(result.rows[0]).toEqual({ on_hand: '8', reserved: '3', count: '1' });
}, 120000);
