import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import {
  createDatabase,
  type DatabaseHandle,
  type Json,
} from '../../../src/platform/database/database.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import type { AddressOperations } from '../../../src/modules/addresses/contracts/addresses.js';
import type { CartService } from '../../../src/modules/cart/contracts/cart.js';
import type { CatalogQuery } from '../../../src/modules/catalog/contracts/catalog.js';
import { AgentNudges } from '../../../src/modules/agent/infrastructure/nudges.js';
import type {
  EmailPort,
  PushPort,
} from '../../../src/modules/notifications/contracts/notifications.js';
import { PostgresNotificationPipeline } from '../../../src/modules/notifications/infrastructure/postgres-pipeline.js';
import type { OrderOperations, OrderView } from '../../../src/modules/orders/contracts/orders.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { assertDisposableAgentDatabase } from './disposable-database.js';
import {
  activeOrderVariants,
  deliveredPurchaseLines,
} from '../../../src/modules/orders/infrastructure/postgres-orders.js';

const DAY = 24 * 60 * 60 * 1000;
const NUDGE_EVENT = 'AGENT_REORDER_NUDGE';
const NUDGE_TEMPLATE = 'agent.reorder_nudge';

let services: TestServices,
  db: DatabaseHandle,
  config: AppConfig,
  nudges: AgentNudges,
  pipeline: PostgresNotificationPipeline;
// Cross-module reads are stubbed in-memory; the SQL under test (preferences,
// outbox, notifications, dedupe counting) runs against real Postgres.
const orderHistory = new Map<string, OrderView[]>();
const carts = new Map<string, { addressId: string; lines: { variantId: string }[] }>();
const catalogItems: { variantId: string; name: string; availability: string }[] = [];
let optedIn: string[] = [];

const ordersPort = {
  purchaseSignals: async (userId: string) => {
    const orders = orderHistory.get(userId) ?? [];
    const delivered = orders
      .filter((entry) => entry.status === 'DELIVERED')
      .flatMap((entry) =>
        entry.items.map((item) => ({
          orderId: `${entry.placedAt}:${item.variantId}`,
          variantId: item.variantId,
          name: item.name,
          placedAt: entry.placedAt,
        })),
      );
    const activeVariantIds = orders
      .filter((entry) =>
        ['CONFIRMED', 'PICKING', 'PACKED', 'OUT_FOR_DELIVERY'].includes(entry.status),
      )
      .flatMap((entry) => entry.items.map((item) => item.variantId));
    return { delivered, activeVariantIds };
  },
} as unknown as OrderOperations;

const order = (
  status: string,
  daysAgo: number,
  variantId: string,
  name = 'Toned Milk',
): OrderView =>
  ({
    status,
    placedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    items: [{ variantId, name }],
  }) as unknown as OrderView;

const setConfig = async (key: string, value: unknown): Promise<void> => {
  await sql`INSERT INTO app_config(key,value) VALUES (${key},${JSON.stringify(value)}::jsonb) ON CONFLICT (key) DO UPDATE SET value=${JSON.stringify(value)}::jsonb,version=app_config.version+1`.execute(
    db.db,
  );
};

const createUser = async (status = 'ACTIVE'): Promise<string> => {
  const id = uuidV7();
  const sub = `nudge-${id}`;
  const email = `nudge-${id}@example.test`;
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,status,email_verified) VALUES
    (${id}::uuid,'CUSTOMER',${sub},${email},'Customer',${status},true)`.execute(db.db);
  await sql`INSERT INTO consents(user_id,type,version) VALUES(${id}::uuid,'ai_assistant','1')`.execute(
    db.db,
  );
  return id;
};

const seedHistory = async (userId: string, variantId: string): Promise<void> => {
  // Three purchases on a ten-day cadence; the last is past the 0.8× trigger.
  orderHistory.set(userId, [
    order('DELIVERED', 10, variantId),
    order('DELIVERED', 20, variantId),
    order('DELIVERED', 30, variantId),
  ]);
  catalogItems.push({ variantId, name: 'Toned Milk', availability: 'IN_STOCK' });
  carts.set(userId, { addressId: uuidV7(), lines: [] });
};

const optIn = async (userId: string): Promise<void> => {
  await sql`INSERT INTO agent_nudge_preferences(user_id,enabled) VALUES(${userId}::uuid,true)`.execute(
    db.db,
  );
  optedIn.push(userId);
};

const seedDueHistory = async (userId: string, variantId: string): Promise<void> => {
  await seedHistory(userId, variantId);
  await optIn(userId);
};

const nudgeEventsFor = async (userId: string): Promise<number> => {
  const rows = await sql<{ count: string }>`SELECT count(*)::text AS count FROM outbox_events
    WHERE event_type=${NUDGE_EVENT} AND payload->>'userId'=${userId}`.execute(db.db);
  return Number(rows.rows[0]?.count ?? 0);
};

const consumeOutboxEvent = async (eventId: string): Promise<void> => {
  await db.db.transaction().execute(async (tx) => {
    const rows = await sql<{
      id: string;
      event_type: string;
      schema_version: number;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: string;
      occurred_at: Date;
      correlation_id: string;
      causation_id: string | null;
      payload: Json;
    }>`SELECT id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version::text AS aggregate_version,occurred_at,correlation_id,causation_id,payload FROM outbox_events WHERE id=${eventId}::uuid`.execute(
      tx,
    );
    const row = rows.rows[0]!;
    await pipeline.consume(tx, {
      eventId: row.id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      occurredAt: row.occurred_at.toISOString(),
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      payload: row.payload,
    });
  });
};

beforeAll(async () => {
  services = await startTestServices({ skipAwsCache: true });
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 4, 10000, undefined, 30000);
  await assertDisposableAgentDatabase(db.db);
  config = new ConfigService(db.db);
  nudges = new AgentNudges(
    db.db,
    ordersPort,
    { get: async (userId: string) => carts.get(userId) ?? null } as unknown as CartService,
    {
      list: async () => ({ items: catalogItems, etag: '"nudge-test"', nextCursor: null }),
    } as unknown as CatalogQuery,
    { list: async () => [] } as unknown as AddressOperations,
    config,
  );
  pipeline = new PostgresNotificationPipeline(
    db.db,
    {} as PushPort,
    {} as EmailPort,
    undefined,
    config,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('agent_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    db.db,
  );
}, 300000);

afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 300000);

afterEach(async () => {
  for (const userId of optedIn)
    await sql`UPDATE agent_nudge_preferences SET enabled=false WHERE user_id=${userId}::uuid`.execute(
      db.db,
    );
  optedIn = [];
});

test('setPreference persists, audits and replays the tool call idempotently', async () => {
  const userId = await createUser();
  const thread = uuidV7();
  await sql`INSERT INTO agent_threads(id,user_id) VALUES(${thread}::uuid,${userId}::uuid)`.execute(
    db.db,
  );
  await expect(nudges.setPreference(userId, true, thread, 'call-1')).resolves.toEqual({
    enabled: true,
  });
  const prefs = await sql<{
    enabled: boolean;
  }>`SELECT enabled FROM agent_nudge_preferences WHERE user_id=${userId}::uuid`.execute(db.db);
  expect(prefs.rows[0]?.enabled).toBe(true);
  const operations = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM agent_tool_operations WHERE thread_id=${thread}::uuid AND tool_call_id='call-1'`.execute(
    db.db,
  );
  expect(operations.rows[0]?.count).toBe('1');
  const audits = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM audit_log WHERE action='AGENT_NUDGE_PREFERENCE' AND subject_id=${userId}`.execute(
    db.db,
  );
  expect(audits.rows[0]?.count).toBe('1');
  // Same tool call id and payload replays the stored result without new rows.
  await expect(nudges.setPreference(userId, true, thread, 'call-1')).resolves.toEqual({
    enabled: true,
  });
  const auditsAfterReplay = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM audit_log WHERE action='AGENT_NUDGE_PREFERENCE' AND subject_id=${userId}`.execute(
    db.db,
  );
  expect(auditsAfterReplay.rows[0]?.count).toBe('1');
  // The same tool call id with a different payload is a key reuse.
  await expect(nudges.setPreference(userId, false, thread, 'call-1')).rejects.toThrow(
    'IDEMPOTENCY_KEY_REUSED',
  );
  await expect(nudges.setPreference(userId, false, thread, 'call-2')).resolves.toEqual({
    enabled: false,
  });
  const disabled = await sql<{
    enabled: boolean;
  }>`SELECT enabled FROM agent_nudge_preferences WHERE user_id=${userId}::uuid`.execute(db.db);
  expect(disabled.rows[0]?.enabled).toBe(false);
});

test('setPreference refuses disabled accounts and unowned or archived threads', async () => {
  const userId = await createUser();
  const blocked = await createUser('BLOCKED');
  const thread = uuidV7();
  await sql`INSERT INTO agent_threads(id,user_id) VALUES(${thread}::uuid,${userId}::uuid)`.execute(
    db.db,
  );
  const archived = uuidV7();
  await sql`INSERT INTO agent_threads(id,user_id,status) VALUES(${archived}::uuid,${userId}::uuid,'archived')`.execute(
    db.db,
  );
  await expect(nudges.setPreference(blocked, true, thread, 'call-1')).rejects.toThrow(
    'ACCOUNT_DISABLED',
  );
  await expect(nudges.setPreference(userId, true, uuidV7(), 'call-1')).rejects.toThrow(
    'RESOURCE_NOT_FOUND',
  );
  await expect(nudges.setPreference(userId, true, archived, 'call-1')).rejects.toThrow(
    'THREAD_ARCHIVED',
  );
  const prefs = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM agent_nudge_preferences WHERE user_id=${userId}::uuid`.execute(
    db.db,
  );
  expect(prefs.rows[0]?.count).toBe('0');
});

test('the sweep is a no-op while the global kill switch is off', async () => {
  const variant = uuidV7();
  const userId = await createUser();
  await seedDueHistory(userId, variant);
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 0, sent: 0 });
  await expect(nudgeEventsFor(userId)).resolves.toBe(0);
});

test('the sweep sends one event for a qualifying user and the pipeline fans it out', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 1);
  const variant = uuidV7();
  const userId = await createUser();
  await seedDueHistory(userId, variant);
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 1 });
  const events = await sql<{
    id: string;
    variant: string;
    product: string;
  }>`SELECT id,payload->>'variantId' AS variant,payload->>'productName' AS product FROM outbox_events
    WHERE event_type=${NUDGE_EVENT} AND payload->>'userId'=${userId}`.execute(db.db);
  expect(events.rows).toHaveLength(1);
  expect(events.rows[0]?.variant).toBe(variant);
  expect(events.rows[0]?.product).toBe('Toned Milk');
  const deliveries = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM outbox_deliveries d
    JOIN outbox_events e ON e.id=d.event_id WHERE e.id=${events.rows[0]!.id}::uuid AND d.consumer='notifications'`.execute(
    db.db,
  );
  expect(deliveries.rows[0]?.count).toBe('1');
  await consumeOutboxEvent(events.rows[0]!.id);
  const notifications = await sql<{
    channel: string;
    template_key: string;
    class: string;
    category: string;
    status: string;
  }>`SELECT channel,template_key,class,category,status FROM notifications WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE}`.execute(
    db.db,
  );
  expect(notifications.rows.sort((a, b) => a.channel.localeCompare(b.channel))).toEqual([
    {
      channel: 'INBOX',
      template_key: NUDGE_TEMPLATE,
      class: 'PROMOTIONAL',
      category: 'PROMOTIONS',
      status: 'PENDING',
    },
    {
      channel: 'PUSH',
      template_key: NUDGE_TEMPLATE,
      class: 'PROMOTIONAL',
      category: 'PROMOTIONS',
      status: 'PENDING',
    },
  ]);
  const attempts = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM notification_deliveries d
    JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=${userId}::uuid AND n.template_key=${NUDGE_TEMPLATE}`.execute(
    db.db,
  );
  expect(attempts.rows[0]?.count).toBe('2');
});

test('a disabled preference never enters the sweep', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  const variant = uuidV7();
  const userId = await createUser();
  await seedHistory(userId, variant);
  await sql`INSERT INTO agent_nudge_preferences(user_id,enabled) VALUES(${userId}::uuid,false)`.execute(
    db.db,
  );
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 0, sent: 0 });
  await expect(nudgeEventsFor(userId)).resolves.toBe(0);
});

test('the weekly cap stops further nudges in the same week', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 1);
  const variant = uuidV7();
  const userId = await createUser();
  await seedDueHistory(userId, variant);
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 1 });
  // The notifications consumer (worker topology) materialises the budget ledger.
  const events = await sql<{ id: string }>`SELECT id FROM outbox_events
    WHERE event_type=${NUDGE_EVENT} AND payload->>'userId'=${userId}`.execute(db.db);
  await consumeOutboxEvent(events.rows[0]!.id);
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 0 });
  await expect(nudgeEventsFor(userId)).resolves.toBe(1);
});

test('concurrent sweeps respect the weekly cap before notifications are materialised', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 1);
  const userId = await createUser(),
    first = uuidV7(),
    second = uuidV7();
  await seedDueHistory(userId, first);
  orderHistory
    .get(userId)!
    .push(
      order('DELIVERED', 10, second, 'Curd'),
      order('DELIVERED', 20, second, 'Curd'),
      order('DELIVERED', 30, second, 'Curd'),
    );
  catalogItems.push({ variantId: second, name: 'Curd', availability: 'IN_STOCK' });
  const results = await Promise.all([nudges.runSweep(new Date()), nudges.runSweep(new Date())]);
  expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);
  expect(await nudgeEventsFor(userId)).toBe(1);
  expect((await nudges.runSweep(new Date())).sent).toBe(0);
});

test('revoked assistant consent stops reminder scheduling', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  const userId = await createUser();
  await seedDueHistory(userId, uuidV7());
  await sql`UPDATE consents SET revoked_at=clock_timestamp() WHERE user_id=${userId}::uuid AND type='ai_assistant'`.execute(
    db.db,
  );
  expect((await nudges.runSweep(new Date())).sent).toBe(0);
  expect(await nudgeEventsFor(userId)).toBe(0);
});

test('an opt-out after scheduling suppresses the queued inbox reminder', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 1);
  const userId = await createUser();
  await seedDueHistory(userId, uuidV7());
  expect((await nudges.runSweep(new Date())).sent).toBe(1);
  const events = await sql<{
    id: string;
  }>`SELECT id FROM outbox_events WHERE event_type=${NUDGE_EVENT} AND payload->>'userId'=${userId}`.execute(
    db.db,
  );
  await consumeOutboxEvent(events.rows[0]!.id);
  const delivery = await sql<{
    id: string;
  }>`SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
    WHERE n.user_id=${userId}::uuid AND n.template_key=${NUDGE_TEMPLATE} AND n.channel='INBOX'`.execute(
    db.db,
  );
  await sql`UPDATE agent_nudge_preferences SET enabled=false WHERE user_id=${userId}::uuid`.execute(
    db.db,
  );
  const midday = new Date();
  midday.setUTCHours(6, 30, 0, 0);
  await pipeline.deliverOnce(delivery.rows[0]!.id, midday);
  const result = await sql<{
    status: string;
  }>`SELECT status FROM notifications WHERE user_id=${userId}::uuid AND template_key=${NUDGE_TEMPLATE} AND channel='INBOX'`.execute(
    db.db,
  );
  expect(result.rows[0]?.status).toBe('SKIPPED');
});

test('a nudge inside the seven-day recency window suppresses the sweep', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 2);
  const variant = uuidV7();
  const userId = await createUser();
  await seedDueHistory(userId, variant);
  await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,status,dedupe_key,payload,created_at) VALUES
    (${uuidV7()}::uuid,${userId}::uuid,'PUSH',${NUDGE_TEMPLATE},'en','PROMOTIONS','PROMOTIONAL','SENT',
     ${`${userId}|PUSH|seeded|seeded|1`},${JSON.stringify({ variantId: variant })}::jsonb,clock_timestamp()-interval '3 days')`.execute(
    db.db,
  );
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 0 });
  await expect(nudgeEventsFor(userId)).resolves.toBe(0);
});

test('a nudge older than seven days no longer suppresses the sweep', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 1);
  const variant = uuidV7();
  const userId = await createUser();
  await seedDueHistory(userId, variant);
  // Eight days ago is always before the current ISO week, so the weekly count
  // is zero and only the recency window matters.
  await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,status,dedupe_key,payload,created_at) VALUES
    (${uuidV7()}::uuid,${userId}::uuid,'PUSH',${NUDGE_TEMPLATE},'en','PROMOTIONS','PROMOTIONAL','SENT',
     ${`${userId}|PUSH|seeded-old|seeded-old|1`},${JSON.stringify({ variantId: variant })}::jsonb,clock_timestamp()-interval '8 days')`.execute(
    db.db,
  );
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 1 });
  await expect(nudgeEventsFor(userId)).resolves.toBe(1);
});

test('variants already in the cart or out of stock are not nudged', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  const inCart = uuidV7();
  const cartUser = await createUser();
  await seedDueHistory(cartUser, inCart);
  carts.set(cartUser, { addressId: uuidV7(), lines: [{ variantId: inCart }] });
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 0 });
  await expect(nudgeEventsFor(cartUser)).resolves.toBe(0);
  await sql`UPDATE agent_nudge_preferences SET enabled=false WHERE user_id=${cartUser}::uuid`.execute(
    db.db,
  );
  optedIn = optedIn.filter((id) => id !== cartUser);

  const outOfStock = uuidV7();
  const stockUser = await createUser();
  await seedDueHistory(stockUser, outOfStock);
  const item = catalogItems.find((entry) => entry.variantId === outOfStock)!;
  item.availability = 'OUT_OF_STOCK';
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 0 });
  await expect(nudgeEventsFor(stockUser)).resolves.toBe(0);
});

test('real delivered rows select the usual item and skip an active variant', async () => {
  await setConfig('agent_proactive_nudges_enabled', true);
  await setConfig('agent_nudge_max_per_week', 2);
  const userId = await createUser();
  const entity = uuidV7();
  const city = uuidV7();
  const store = uuidV7();
  const category = uuidV7();
  const milkProduct = uuidV7();
  const breadProduct = uuidV7();
  const milk = uuidV7();
  const bread = uuidV7();
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((76 11,79 11,79 14,76 14,76 11))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'east',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published) VALUES(${milkProduct}::uuid,${category}::uuid,'Toned Milk','toned milk','0401',500,true),(${breadProduct}::uuid,${category}::uuid,'Bread','bread','1905',500,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${milk}::uuid,${milkProduct}::uuid,'500 ml',${milk}),(${bread}::uuid,${breadProduct}::uuid,'400 g',${bread})`.execute(
    db.db,
  );
  const insertOrder = async (
    status: 'DELIVERED' | 'CONFIRMED',
    variantId: string,
    name: string,
    daysAgo: number,
  ) => {
    const orderId = uuidV7();
    const placed = new Date(Date.now() - daysAgo * DAY).toISOString();
    await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,wallet_promo_paise,wallet_cash_paise,amount_due_paise,placed_at)
      VALUES(${orderId}::uuid,${`N${orderId.replaceAll('-', '').slice(0, 20).toUpperCase()}`},${userId}::uuid,${store}::uuid,'{}'::jsonb,${status},'PAID','COD',100,0,0,0,0,100,0,0,100,${placed}::timestamptz)`.execute(
      db.db,
    );
    await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,unit_price_paise,mrp_paise,tax_rate_bps,hsn_code) VALUES(${uuidV7()}::uuid,${orderId}::uuid,${variantId}::uuid,${name},2,100,100,500,'0401')`.execute(
      db.db,
    );
  };
  for (const days of [30, 20, 10]) await insertOrder('DELIVERED', milk, 'Toned Milk', days);
  for (const days of [28, 18, 8]) await insertOrder('DELIVERED', bread, 'Bread', days);
  await insertOrder('CONFIRMED', bread, 'Bread', 0);
  const signals = {
    purchaseSignals: async (owner: string, limit = 20) => {
      const delivered = await deliveredPurchaseLines(db.db, owner, limit);
      return {
        delivered: delivered.map((line) => ({
          orderId: line.orderId,
          variantId: line.variantId,
          name: line.name,
          placedAt: line.placedAt,
        })),
        activeVariantIds: await activeOrderVariants(db.db, owner),
      };
    },
  } as unknown as OrderOperations;
  const real = new AgentNudges(
    db.db,
    signals,
    { get: async (owner: string) => carts.get(owner) ?? null } as unknown as CartService,
    {
      list: async () => ({ items: catalogItems, etag: '"nudge-test"', nextCursor: null }),
    } as unknown as CatalogQuery,
    { list: async () => [] } as unknown as AddressOperations,
    config,
  );
  catalogItems.push(
    { variantId: milk, name: 'Toned Milk', availability: 'IN_STOCK' },
    { variantId: bread, name: 'Bread', availability: 'IN_STOCK' },
  );
  carts.set(userId, { addressId: uuidV7(), lines: [] });
  await optIn(userId);
  await expect(real.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 1 });
  const events = await sql<{
    variant: string;
  }>`SELECT payload->>'variantId' AS variant FROM outbox_events WHERE event_type=${NUDGE_EVENT} AND payload->>'userId'=${userId}`.execute(
    db.db,
  );
  expect(events.rows.map((row) => row.variant)).toEqual([milk]);
  await expect(real.runSweep(new Date())).resolves.toEqual({ checked: 1, sent: 0 });
  await expect(nudgeEventsFor(userId)).resolves.toBe(1);
});
