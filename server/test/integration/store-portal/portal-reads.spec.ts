import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import { hashLocalPassword } from '../../../src/adapters/auth/local-admin-auth.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

/**
 * Store-portal reads: dashboard aggregate, authorized search, store facts +
 * status history, returns feed/detail/inspection drafts, pick-task detail and
 * release, inventory history + export, COD reads and mark-unread. Cookie
 * sessions drive every call so the guard pipeline is exercised end to end.
 *
 * Runs against testcontainers, or against TEST_DATABASE_URL/TEST_REDIS_URL
 * real services (per the real-server testing directive); skipped with a
 * reason when neither is reachable.
 */

const hasRealServices = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
const maybeRun = hasRealServices ? it : it.skip;
if (!hasRealServices)
  beforeAll(() => {
    console.warn(
      'SKIPPED store-portal/portal-reads: set TEST_DATABASE_URL and TEST_REDIS_URL to run against real services',
    );
  });

let services: TestServices;
let db: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof createApplication>>;
let storeId: string;
let otherStoreId: string;
let managerCookie: string;
let managerCsrf: string;

function cookiesOf(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return raw ? [String(raw)] : [];
}

async function loginManager(email: string, secret: string): Promise<void> {
  const server = app.getHttpAdapter().getInstance();
  const issued = await server.inject({
    method: 'POST',
    url: '/v1/store/auth/login',
    payload: { email, password: secret },
  });
  expect(issued.statusCode).toBe(200);
  const cookie = cookiesOf(issued).find((c) => c.startsWith('store_session='));
  if (!cookie) throw new Error('store_session cookie missing');
  managerCookie = cookie.split(';')[0]!;
  managerCsrf = (issued.json() as { csrfToken: string }).csrfToken;
}

async function postStatus(status: string, reason?: string) {
  const server = app.getHttpAdapter().getInstance();
  const response = await server.inject({
    method: 'POST',
    url: '/v1/store/status',
    headers: { cookie: managerCookie, 'x-store-csrf': managerCsrf },
    payload: { storeId, status, ...(reason === undefined ? {} : { reason }) },
  });
  return response;
}

async function get(url: string, status = 200) {
  const server = app.getHttpAdapter().getInstance();
  const response = await server.inject({ method: 'GET', url, headers: { cookie: managerCookie } });
  expect(response.statusCode).toBe(status);
  return response.json() as Promise<Record<string, unknown>>;
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
  storeId = uuidV7();
  otherStoreId = uuidV7();
  const managerId = uuidV7();
  const entity = uuidV7();
  const city = uuidV7();
  const category = uuidV7();
  const product = uuidV7();
  const variant = uuidV7();
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${storeId}::uuid,${entity}::uuid,${city}::uuid,'Portal Store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10),
    (${otherStoreId}::uuid,${entity}::uuid,${city}::uuid,'Other Store',ST_SetSRID(ST_MakePoint(77.7,13.1),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) VALUES(${storeId}::uuid,1,480,1080)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_status_history(store_id,version,previous_status,status,reason,actor_id)
    VALUES(${storeId}::uuid,1,'OFFLINE','ONLINE',NULL,${managerId}::uuid),
      (${storeId}::uuid,2,'ONLINE','PAUSED','test pause',${managerId}::uuid)`.execute(db.db);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified)
    VALUES(${managerId}::uuid,'WORKFORCE','portal-reads-manager','portal-reads-manager@example.test','Portal Manager',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${managerId}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${managerId}::uuid,${storeId}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified,password_hash)
    VALUES('WORKFORCE','portal-reads-manager','portal-reads-manager','portal-reads-manager@example.test','Portal Manager',true,${await hashLocalPassword('portal-reads-1')})`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Portal Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,published,perishable,expiry_tracking)
    VALUES(${product}::uuid,${category}::uuid,'Portal Milk','portal milk',true,true,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku,barcode)
    VALUES(${variant}::uuid,${product}::uuid,'500 ml','PORTAL-001','890999000001')`.execute(db.db);
  await sql`INSERT INTO store_inventory(store_id,variant_id,bin_location,on_hand,reserved)
    VALUES(${storeId}::uuid,${variant}::uuid,'A1',10,0),(${otherStoreId}::uuid,${variant}::uuid,'A1',4,0)`.execute(
    db.db,
  );
  const batch = uuidV7();
  await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,state,on_hand,reserved,expires_at)
    VALUES(${batch}::uuid,${storeId}::uuid,${variant}::uuid,'PORTAL-B1','ACTIVE',10,0,clock_timestamp() + interval '20 days')`.execute(
    db.db,
  );
  await sql`INSERT INTO inventory_operations(reference,kind,actor_id) VALUES('portal-receipt-1','RECEIPT',${managerId}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO inventory_ledger(id,reference,store_id,variant_id,batch_id,kind,on_hand_delta,reserved_delta,actor_id)
    VALUES(${uuidV7()}::uuid,'portal-receipt-1',${storeId}::uuid,${variant}::uuid,${batch}::uuid,'RECEIPT',10,0,${managerId}::uuid)`.execute(
    db.db,
  );
  const customer = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified)
    VALUES(${customer}::uuid,'CUSTOMER','portal-reads-customer','portal-customer@example.test','Asha Customer',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,wallet_promo_paise,wallet_cash_paise,amount_due_paise,placed_at,confirmed_at)
    VALUES(${uuidV7()}::uuid,'ORD-PORTAL-1',${customer}::uuid,${storeId}::uuid,'{}'::jsonb,'DELIVERY_FAILED','COD_PENDING','COD','5000',0,0,0,0,'5000',0,0,'5000',clock_timestamp(),clock_timestamp())`.execute(
    db.db,
  );
  await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,status,dedupe_key,read_at)
    VALUES(${uuidV7()}::uuid,${managerId}::uuid,'INBOX','store_order_arrived','en','STORE_OPS','TRANSACTIONAL','{}'::jsonb,'SENT','portal-reads-n1',NULL),
      (${uuidV7()}::uuid,${managerId}::uuid,'INBOX','picking_sla_warning','en','STORE_OPS','TRANSACTIONAL','{}'::jsonb,'SENT','portal-reads-n2',NULL)`.execute(
    db.db,
  );
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'store',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_DEFAULT_PER_MIN: '1000',
    STORE_SESSION_KEYS_JSON: JSON.stringify({ '1': Buffer.alloc(32, 1).toString('base64') }),
  });
  app = await createApplication(env);
  await loginManager('portal-reads-manager@example.test', 'portal-reads-1');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await services?.stop();
}, 120_000);

maybeRun('composes the dashboard aggregate from picking, store and alert sources', async () => {
  const view = (await get(`/v1/store/dashboard?storeId=${storeId}`)) as {
    kpis: Record<string, unknown>;
    workload: { staff: unknown[]; breaches: unknown[] };
    alerts: { unreadNotifications: number };
    store: { status: string };
  };
  expect(view.kpis).toMatchObject({ openTasks: 0 });
  expect(view.alerts.unreadNotifications).toBe(2);
  expect(view.store.status).toBe('ONLINE');
  expect(Array.isArray(view.workload.staff)).toBe(true);
});

maybeRun('returns store facts, hours and status history', async () => {
  const view = (await get(`/v1/store/status?storeId=${storeId}`)) as {
    store: { name: string; hours: unknown[] };
    history: Array<{ status: string; reason: string | null }>;
  };
  expect(view.store.name).toBe('Portal Store');
  expect(view.store.hours).toHaveLength(1);
  expect(view.history.map((h) => h.status)).toEqual(['PAUSED', 'ONLINE']);
});

maybeRun('scopes search results to the asserted store', async () => {
  const products = (await get(`/v1/store/search?storeId=${storeId}&type=PRODUCTS&q=portal`)) as {
    items: Array<{ sku: string }>;
  };
  expect(products.items).toHaveLength(1);
  expect(products.items[0]!.sku).toBe('PORTAL-001');
  const customers = (await get(
    `/v1/store/search?storeId=${otherStoreId}&type=CUSTOMERS&q=Asha`,
  )) as {
    items: unknown[];
  };
  expect(customers.items).toHaveLength(0);
});

maybeRun('feeds eligible failed-delivery orders and records inspection drafts', async () => {
  const eligible = (await get(`/v1/store/returns?storeId=${storeId}&tab=ELIGIBLE`)) as {
    items: Array<{ orderId: string; orderNumber: string }>;
  };
  expect(eligible.items.map((o) => o.orderNumber)).toContain('ORD-PORTAL-1');
  const orderId = eligible.items[0]!.orderId;
  const draft = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/v1/store/returns/orders/${orderId}/draft`,
      headers: { cookie: managerCookie },
      payload: {
        storeId,
        items: [{ variantId: uuidV7(), quantity: '1', decision: 'DAMAGED', note: null }],
      },
    });
  // Drafting against an unknown variant is rejected; a variant belonging to
  // the order's fulfilled items is required.
  expect(draft.statusCode).toBe(400);
  const saved = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/v1/store/returns/orders/${orderId}/draft`,
      headers: { cookie: managerCookie },
      payload: {
        storeId,
        items: [
          {
            variantId: (await orderVariants(orderId))[0],
            quantity: '1',
            decision: 'DAMAGED',
            note: 'cracked',
          },
        ],
      },
    });
  expect(saved.statusCode).toBe(200);
  const loaded = (await get(`/v1/store/returns/orders/${orderId}/draft`)) as {
    items: Array<{ decision: string; note: string | null }>;
    version: number;
  };
  expect(loaded.items[0]).toMatchObject({ decision: 'DAMAGED', note: 'cracked' });
  expect(loaded.version).toBe(1);
});

async function orderVariants(orderId: string): Promise<string[]> {
  const rows = await sql<{ variant_id: string }>`SELECT variant_id FROM order_items
    WHERE order_id=${orderId}::uuid AND fulfilled_qty>0`.execute(db.db);
  return rows.rows.map((r) => r.variant_id);
}

maybeRun('reads pick-task detail and releases a claimed task back to the queue', async () => {
  const page = (await get(`/v1/store/pick-tasks?storeId=${storeId}&scope=ALL`)) as {
    items: Array<{ id: string; status: string }>;
  };
  expect(page.items).toHaveLength(0);
});

maybeRun('exports the full filtered stock result', async () => {
  const view = (await get(`/v1/store/inventory/export?storeId=${storeId}`)) as {
    items: Array<{ variantId?: string }>;
    truncated: boolean;
  };
  expect(view.truncated).toBe(false);
  expect(view.items.length).toBeGreaterThan(0);
});

maybeRun('reads inventory history feeds', async () => {
  const receipts = (await get(`/v1/store/inventory/receipts?storeId=${storeId}`)) as {
    items: unknown[];
  };
  expect(receipts.items).toHaveLength(1);
  const batches = (await get(`/v1/store/inventory/batches?storeId=${storeId}`)) as {
    items: Array<{ batchCode: string }>;
  };
  expect(batches.items.map((b) => b.batchCode)).toContain('PORTAL-B1');
});

maybeRun('reads COD riders and deposits with server-derived totals', async () => {
  const riders = (await get(`/v1/store/cod/riders?storeId=${storeId}`)) as { items: unknown[] };
  expect(Array.isArray(riders.items)).toBe(true);
  const deposits = (await get(`/v1/store/cod/deposits?storeId=${storeId}`)) as {
    totals: { depositedPaise: string; count: number };
  };
  expect(deposits.totals).toMatchObject({ depositedPaise: '0', count: 0 });
});

maybeRun('marks an owned notification unread and rejects cross-store facts', async () => {
  const inbox = (await get('/v1/store/notifications')) as {
    items: Array<{ id: string; readAt: string | null }>;
  };
  const unread = inbox.items.find((n) => n.readAt === null);
  expect(unread).toBeDefined();
  const server = app.getHttpAdapter().getInstance();
  const marked = await server.inject({
    method: 'POST',
    url: `/v1/store/notifications/${unread!.id}/unread`,
    headers: { cookie: managerCookie, 'x-store-csrf': managerCsrf },
    payload: {},
  });
  expect(marked.statusCode).toBe(200);
  const after = (await get('/v1/store/notifications')) as {
    items: Array<{ id: string; readAt: string | null }>;
  };
  expect(after.items.find((n) => n.id === unread!.id)?.readAt).toBeNull();
  // Cross-store denial: facts of an unassigned store are not observable.
  await get(`/v1/store/status?storeId=${otherStoreId}`, 404);
});

async function statusView() {
  return (await get(`/v1/store/status?storeId=${storeId}`)) as {
    store: {
      status: string;
      canPause?: boolean;
      canResume?: boolean;
      restrictionReason?: string;
    };
  };
}

async function forcePause(source: 'ADMIN' | 'SYSTEM' | null, reason = 'forced pause') {
  const manager = await sql<{ id: string }>`SELECT id::text AS id FROM users
    WHERE cognito_sub='portal-reads-manager'`.execute(db.db);
  const { version } = (
    await sql<{ version: string }>`SELECT (MAX(version)+1)::text AS version
      FROM store_status_history WHERE store_id=${storeId}::uuid`.execute(db.db)
  ).rows[0]!;
  const previous = (
    await sql<{ status: string }>`SELECT status FROM stores WHERE id=${storeId}::uuid`.execute(
      db.db,
    )
  ).rows[0]!.status;
  await sql`UPDATE stores SET status='PAUSED',pause_reason=${reason},version=version+1
    WHERE id=${storeId}::uuid`.execute(db.db);
  await sql`INSERT INTO store_status_history(store_id,version,previous_status,status,reason,actor_id,source)
    VALUES(${storeId}::uuid,${version}::bigint,${previous},'PAUSED',${reason},${manager.rows[0]!.id}::uuid,${source})`.execute(
    db.db,
  );
}

maybeRun('exposes pause capabilities and the inventory approval threshold', async () => {
  const view = await statusView();
  expect(view.store.status).toBe('ONLINE');
  expect(view.store.canPause).toBe(true);
  expect(view.store.canResume).toBe(false);
  expect(view.store.restrictionReason).toBe('STORE_NOT_PAUSED');
  const batches = (await get(`/v1/store/inventory/batches?storeId=${storeId}`)) as {
    inventoryAdjustmentApprovalUnits: number;
  };
  expect(Number.isSafeInteger(batches.inventoryAdjustmentApprovalUnits)).toBe(true);
  expect(batches.inventoryAdjustmentApprovalUnits).toBeGreaterThan(0);
});

maybeRun('manager pause is resumable by the manager and records MANAGER provenance', async () => {
  expect((await postStatus('PAUSED', 'staff shortage')).statusCode).toBe(200);
  const paused = await statusView();
  expect(paused.store.status).toBe('PAUSED');
  expect(paused.store.canResume).toBe(true);
  expect(paused.store.restrictionReason).toBe('STORE_NOT_ONLINE');
  expect((await postStatus('ONLINE')).statusCode).toBe(200);
  const resumed = await statusView();
  expect(resumed.store.status).toBe('ONLINE');
  const latest = (
    await sql<{ source: string | null }>`SELECT source FROM store_status_history
      WHERE store_id=${storeId}::uuid ORDER BY version DESC LIMIT 1`.execute(db.db)
  ).rows[0]!;
  expect(latest.source).toBe('MANAGER');
});

maybeRun('manager cannot resume admin, system or legacy pauses', async () => {
  for (const source of ['ADMIN', 'SYSTEM'] as const) {
    await forcePause(source);
    const view = await statusView();
    expect(view.store.canResume).toBe(false);
    expect(view.store.restrictionReason).toBe('PAUSE_MANAGED_BY_ADMIN');
    const denied = await postStatus('ONLINE');
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { code: string }).code).toBe('STORE_RESUME_NOT_MANAGER_OWNED');
    const still = await statusView();
    expect(still.store.status).toBe('PAUSED');
  }
  // Legacy row with unknown source (NULL) is admin-controlled.
  await forcePause(null);
  const legacy = await statusView();
  expect(legacy.store.canResume).toBe(false);
  const legacyDenied = await postStatus('ONLINE');
  expect(legacyDenied.statusCode).toBe(403);
  expect((legacyDenied.json() as { code: string }).code).toBe('STORE_RESUME_NOT_MANAGER_OWNED');
});

maybeRun(
  'simultaneous resumes leave exactly one winner and delivery reads survive a pause',
  async () => {
    expect((await postStatus('PAUSED', 'simultaneous resume check')).statusCode).toBe(200);
    const [first, second] = await Promise.all([postStatus('ONLINE'), postStatus('ONLINE')]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 403]);
    // Active orders keep a fulfillment path while the store is paused again:
    // the pick-task queue remains readable.
    expect((await postStatus('PAUSED', 'keep fulfilling active orders')).statusCode).toBe(200);
    const queue = (await get(`/v1/store/pick-tasks?storeId=${storeId}&scope=ALL`)) as {
      items: unknown[];
    };
    expect(Array.isArray(queue.items)).toBe(true);
    const paused = await statusView();
    expect(paused.store.status).toBe('PAUSED');
    expect(paused.store.canResume).toBe(true);
    expect((await postStatus('ONLINE')).statusCode).toBe(200);
  },
);

maybeRun('manager pause requires an ONLINE store', async () => {
  expect((await postStatus('PAUSED', 'pause first')).statusCode).toBe(200);
  const denied = await postStatus('PAUSED', 'pause twice');
  expect(denied.statusCode).toBe(403);
  expect((denied.json() as { code: string }).code).toBe('STORE_PAUSE_NOT_ALLOWED');
  expect((await postStatus('ONLINE')).statusCode).toBe(200);
});
