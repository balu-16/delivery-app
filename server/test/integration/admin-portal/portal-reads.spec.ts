import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof createApplication>>;
let adminSub: string;
const storeA = '01800000-0000-7000-8000-0000000000a1';
const customerSub = 'portal-customer';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function seedOrder(options: {
  number: string;
  status: string;
  placedAt: Date;
  onHold?: boolean;
  paymentMethod?: string;
  amountDue?: string;
}): Promise<string> {
  const id = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,
    subtotal_paise,total_paise,amount_due_paise,placed_at,on_hold)
    VALUES (${id}::uuid,${options.number},${await customerId()}::uuid,${storeA}::uuid,'{}'::jsonb,${options.status},'UNPAID',
      ${options.paymentMethod ?? 'GATEWAY'},100000,100000,${options.amountDue ?? '100000'},${options.placedAt.toISOString()}::timestamptz,
      ${options.onHold ?? false})`.execute(db.db);
  return id;
}

let cachedCustomerId: string | null = null;
async function customerId(): Promise<string> {
  if (cachedCustomerId) return cachedCustomerId;
  const rows = await sql<{
    id: string;
  }>`SELECT id::text AS id FROM users WHERE cognito_sub=${customerSub}`.execute(db.db);
  cachedCustomerId = rows.rows[0]!.id;
  return cachedCustomerId;
}

beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl);
  adminSub = 'portal-read-admin';
  const adminId = uuidV7();
  const supportId = uuidV7();
  const customerIdValue = uuidV7();
  const riderId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${adminId}::uuid,'WORKFORCE',${adminSub},'portal-read-admin@example.test','Read Admin',true),
    (${supportId}::uuid,'WORKFORCE','portal-read-support','portal-read-support@example.test','Read Support',true),
    (${customerIdValue}::uuid,'CUSTOMER',${customerSub},'portal-customer@example.test','Portal Customer',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES
    (${adminId}::uuid,'SUPER_ADMIN'),(${supportId}::uuid,'SUPPORT_AGENT')`.execute(db.db);
  await sql`INSERT INTO legal_entities(id,name) VALUES ('01800000-0000-7000-8000-0000000000e1','Portal Legal')`.execute(
    db.db,
  );
  await sql`INSERT INTO cities(id,name,bounds) VALUES ('01800000-0000-7000-8000-0000000000c1','Bengaluru',
    ST_GeomFromText('POLYGON((77.0 12.5,77.9 12.5,77.9 13.4,77.0 13.4,77.0 12.5))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${storeA}::uuid,'01800000-0000-7000-8000-0000000000e1'::uuid,'01800000-0000-7000-8000-0000000000c1'::uuid,'Alpha Dairy Store',
    ST_SetSRID(ST_MakePoint(77.59,12.97),4326),'ONLINE',60)`.execute(db.db);
  await sql`INSERT INTO rider_profiles(user_id,status,home_store_id) VALUES (${riderId}::uuid,'APPROVED',${storeA}::uuid)`.execute(
    db.db,
  );
  await sql`UPDATE users SET name='Riley Rider' WHERE id=${riderId}::uuid`.execute(db.db);
  await sql`INSERT INTO rider_status(rider_id) VALUES (${riderId}::uuid)`.execute(db.db);
  await sql`INSERT INTO catalog_categories(id,name) VALUES ('01800000-0000-7000-8000-0000000000b1','Milk')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,published) VALUES
    ('01800000-0000-7000-8000-0000000000b2'::uuid,'01800000-0000-7000-8000-0000000000b1'::uuid,'Toned Milk 1L','toned milk 1l',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES
    ('01800000-0000-7000-8000-0000000000b3'::uuid,'01800000-0000-7000-8000-0000000000b2'::uuid,'1L pouch','SKU-MILK-1')`.execute(
    db.db,
  );
  await sql`INSERT INTO store_inventory(store_id,variant_id,on_hand,reserved) VALUES
    (${storeA}::uuid,'01800000-0000-7000-8000-0000000000b3'::uuid,7,2)`.execute(db.db);
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'admin',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_DEFAULT_PER_MIN: '1000',
    ADMIN_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
  });
  app = await createApplication(env);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
  await services?.stop();
}, 120_000);

async function injectAsAdmin(
  method: 'GET' | 'POST',
  url: string,
): Promise<{ statusCode: number; json: () => unknown }> {
  const token = await new LocalTokenAdapter('local-dev-only-change-me', db.db).issue(
    'WORKFORCE',
    adminSub,
    'admin',
    'access',
  );
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
    });
}

it('aggregates dashboard money and order counts for the Asia/Kolkata window', async () => {
  const orderId = await seedOrder({
    number: 'P14DASH1',
    status: 'DELIVERED',
    placedAt: new Date(),
  });
  await seedOrder({ number: 'P14DASH2', status: 'CANCELLED', placedAt: new Date() });
  await seedOrder({ number: 'P14DASH3', status: 'CONFIRMED', placedAt: new Date(), onHold: true });
  await sql`INSERT INTO invoice_documents(id,legal_entity_id,order_id,kind,financial_year,seq_no,number,status,payload,renderer_state,issued_at)
    VALUES
    ('01800000-0000-7000-8000-0000000000d1'::uuid,'01800000-0000-7000-8000-0000000000e1'::uuid,${orderId}::uuid,'INVOICE','2026-27',1,'INV-2026-27-1','ISSUED','{"totalPaise":"100000"}'::jsonb,'RENDERED',clock_timestamp()),
    ('01800000-0000-7000-8000-0000000000d2'::uuid,'01800000-0000-7000-8000-0000000000e1'::uuid,${orderId}::uuid,'CREDIT_NOTE','2026-27',2,'CN-2026-27-2','ISSUED','{"totalPaise":"20000"}'::jsonb,'RENDERED',clock_timestamp())`.execute(
    db.db,
  );
  const response = await injectAsAdmin('GET', `/v1/admin/dashboard?from=${today()}&to=${today()}`);
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    period: { from: string; to: string };
    invoicedSalesPaise: string | null;
    creditNotesPaise: string | null;
    orders: Record<string, number>;
    stores: { total: number; online: number };
    customers: { total: number; active: number };
    walletTopUpsPaise: { total: string | null };
  };
  expect(body.period).toEqual({ from: today(), to: today() });
  expect(body.invoicedSalesPaise).toBe('80000');
  expect(body.creditNotesPaise).toBe('20000');
  expect(body.orders).toMatchObject({ delivered: 1, cancelled: 1, onHold: 1 });
  expect(body.stores.online).toBeGreaterThanOrEqual(1);
  expect(body.customers.total).toBeGreaterThanOrEqual(1);
  expect(body.walletTopUpsPaise.total).toEqual(expect.any(String));
  const rejected = await injectAsAdmin('GET', `/v1/admin/dashboard?from=${today()}&to=2020-01-01`);
  expect(rejected.statusCode).toBe(400);
  const tooWide = await injectAsAdmin('GET', '/v1/admin/dashboard?from=2020-01-01&to=2020-12-01');
  expect(tooWide.statusCode).toBe(400);
});

it('rejects non-super-admin roles with 403 on portal reads', async () => {
  const token = await new LocalTokenAdapter('local-dev-only-change-me', db.db).issue(
    'WORKFORCE',
    'portal-read-support',
    'admin',
    'access',
  );
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'GET',
      url: `/v1/admin/dashboard?from=${today()}&to=${today()}`,
      headers: { authorization: `Bearer ${token}` },
    });
  expect(response.statusCode).toBe(403);
  expect((response.json() as { code: string }).code).toBe('FORBIDDEN');
});

it('lists rider candidates with dispatch eligibility reasons', async () => {
  const orderId = await seedOrder({ number: 'P14CAND1', status: 'PACKED', placedAt: new Date() });
  const response = await injectAsAdmin('GET', `/v1/admin/orders/${orderId}/rider-candidates`);
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    items: { riderId: string; eligible: boolean; reason: string | null }[];
  };
  expect(body.items).toHaveLength(1);
  // The seeded rider never came online: dispatch eligibility answers OFFLINE.
  expect(body.items[0]!.eligible).toBe(false);
  expect(body.items[0]!.reason).toBe('OFFLINE');
  const missing = await injectAsAdmin('GET', `/v1/admin/orders/${uuidV7()}/rider-candidates`);
  expect(missing.statusCode).toBe(404);
  expect((missing.json() as { code: string }).code).toBe('ORDER_NOT_FOUND');
  const malformed = await injectAsAdmin('GET', '/v1/admin/orders/not-a-uuid/rider-candidates');
  expect(malformed.statusCode).toBe(400);
});

it('serves fleet availability with bounded items and the freshness window', async () => {
  const response = await injectAsAdmin('GET', '/v1/admin/delivery/fleet');
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    items: { riderId: string; availability: string; fresh: boolean }[];
    freshnessSeconds: number;
  };
  expect(body.freshnessSeconds).toBe(120);
  expect(body.items.some((item) => item.availability === 'OFFLINE')).toBe(true);
});

it('answers invoice reads with 404 and 409 problem codes', async () => {
  const missing = await seedOrder({ number: 'P14INV1', status: 'DELIVERED', placedAt: new Date() });
  const noInvoice = await injectAsAdmin('GET', `/v1/admin/orders/${missing}/invoice`);
  expect(noInvoice.statusCode).toBe(404);
  expect((noInvoice.json() as { code: string }).code).toBe('INVOICE_NOT_FOUND');
  const pendingId = await seedOrder({
    number: 'P14INV2',
    status: 'DELIVERED',
    placedAt: new Date(),
  });
  await sql`INSERT INTO invoice_documents(id,legal_entity_id,order_id,kind,financial_year,seq_no,number,status,payload,renderer_state)
    VALUES (${uuidV7()}::uuid,'01800000-0000-7000-8000-0000000000e1'::uuid,${pendingId}::uuid,'INVOICE','2026-27',3,'INV-2026-27-3','ISSUED','{"totalPaise":"100000"}'::jsonb,'PENDING')`.execute(
    db.db,
  );
  const pending = await injectAsAdmin('GET', `/v1/admin/orders/${pendingId}/invoice`);
  expect(pending.statusCode).toBe(409);
  expect((pending.json() as { code: string }).code).toBe('INVOICE_NOT_RENDERED');
});

it('paginates payment attempts, refunds, inventory, ratings and legal holds', async () => {
  const orderId = await seedOrder({
    number: 'P14PAY1',
    status: 'CONFIRMED',
    placedAt: new Date(),
  });
  await sql`INSERT INTO payment_attempts(id,aggregate_id,kind,order_id,user_id,operation_reference,gateway,amount_paise,status,captured_at)
    VALUES
    (${uuidV7()}::uuid,${orderId}::uuid,'ORDER_PAYMENT',${orderId}::uuid,${await customerId()}::uuid,'portal-payment-001','fake','100000','CAPTURED',clock_timestamp()),
    (${uuidV7()}::uuid,${orderId}::uuid,'WALLET_TOPUP',NULL,${await customerId()}::uuid,'portal-topup-001','fake','50000','CAPTURED',clock_timestamp())`.execute(
    db.db,
  );
  await sql`INSERT INTO payment_refunds(id,order_id,refund_reference,source_type,source_id,amount_paise,destination,status)
    VALUES (${uuidV7()}::uuid,${orderId}::uuid,'portal-refund-001','GATEWAY_CAPTURE','src-1','20000','GATEWAY','PROCESSED')`.execute(
    db.db,
  );
  const attempts = await injectAsAdmin('GET', '/v1/admin/payments/attempts?limit=1');
  expect(attempts.statusCode).toBe(200);
  const attemptPage = attempts.json() as { items: unknown[]; nextCursor: string | null };
  expect(attemptPage.items).toHaveLength(1);
  expect(typeof attemptPage.nextCursor).toBe('string');
  const nextPage = await injectAsAdmin(
    'GET',
    `/v1/admin/payments/attempts?limit=1&cursor=${attemptPage.nextCursor}`,
  );
  expect((nextPage.json() as { items: unknown[] }).items).toHaveLength(1);
  const filtered = await injectAsAdmin(
    'GET',
    '/v1/admin/payments/attempts?status=CAPTURED&method=GATEWAY&search=portal-payment',
  );
  expect(filtered.statusCode).toBe(200);
  const badStatus = await injectAsAdmin('GET', '/v1/admin/payments/attempts?status=NOPE');
  expect(badStatus.statusCode).toBe(400);
  const badLimit = await injectAsAdmin('GET', '/v1/admin/payments/attempts?limit=0');
  expect(badLimit.statusCode).toBe(400);
  const refunds = await injectAsAdmin('GET', '/v1/admin/refunds?status=PROCESSED');
  expect(refunds.statusCode).toBe(200);
  expect((refunds.json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
  const summary = await injectAsAdmin('GET', '/v1/admin/inventory/summary?search=milk');
  expect(summary.statusCode).toBe(200);
  expect(summary.json()).toMatchObject({
    items: [
      {
        sku: 'SKU-MILK-1',
        units: '7',
        totalReserved: '2',
        availableStores: 1,
        lowStockStores: 1,
      },
    ],
    nextCursor: null,
  });
  const legalHolds = await injectAsAdmin('GET', '/v1/admin/legal-holds');
  expect(legalHolds.statusCode).toBe(200);
  expect(legalHolds.json()).toMatchObject({ items: [], nextCursor: null });
  const ratings = await injectAsAdmin('GET', '/v1/admin/ratings?queueOnly=true');
  expect(ratings.statusCode).toBe(200);
  expect(ratings.json()).toMatchObject({ items: [], nextCursor: null });
});

it('returns bounded search groups', async () => {
  const response = await injectAsAdmin('GET', '/v1/admin/search?q=alpha');
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    groups: { group: string; items: { id: string; title: string }[] }[];
  };
  expect(body.groups[0]).toMatchObject({
    group: 'Stores',
    items: [{ title: 'Alpha Dairy Store' }],
  });
  const short = await injectAsAdmin('GET', '/v1/admin/search?q=a');
  expect(short.statusCode).toBe(400);
});
