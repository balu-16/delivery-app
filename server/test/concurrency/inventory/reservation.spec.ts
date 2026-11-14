import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { Client } from 'pg';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresInventoryManagement } from '../../../src/modules/inventory/infrastructure/management.js';
import { PostgresReservations } from '../../../src/modules/inventory/infrastructure/reservations.js';
import { InventoryExpiry } from '../../../src/modules/inventory/infrastructure/expiry.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices,
  db: DatabaseHandle,
  inventory: PostgresInventoryManagement,
  reservations: PostgresReservations;
const entity = uuidV7(),
  city = uuidV7(),
  store = uuidV7(),
  manager = uuidV7(),
  category = uuidV7(),
  product = uuidV7();
async function variant(): Promise<string> {
  const id = uuidV7();
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${id}::uuid,${product}::uuid,'Unit',${id})`.execute(
    db.db,
  );
  await sql`INSERT INTO store_inventory(store_id,variant_id) VALUES(${store}::uuid,${id}::uuid)`.execute(
    db.db,
  );
  return id;
}
const input = (id: string, orderId = uuidV7()) => ({
  orderId,
  lines: [{ storeId: store, variantId: id, quantity: '1' }],
  targetDeliveryAt: new Date(Date.now() + 60000).toISOString(),
  ttlSeconds: 900,
});
let fixtureOrderBatch = 0;
/**
 * Migration 007 enforces inventory_reservations.order_id -> orders(id) on NEW
 * rows (NOT VALID only relieves pre-existing rows), so reservation fixtures
 * insert a real minimal orders row before reserving. Assertions are unchanged.
 */
async function seedFixtureOrders(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => uuidV7());
  const batch = ++fixtureOrderBatch;
  for (const [index, orderId] of ids.entries())
    await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at)
      VALUES(${orderId}::uuid,${'FIX' + batch + '-' + index + '-' + orderId.slice(0, 8).toUpperCase()}::text,${manager}::uuid,${store}::uuid,'{"line1":"road"}'::jsonb,'PENDING_PAYMENT','UNPAID',100,100,100,statement_timestamp())`.execute(
      db.db,
    );
  return ids;
}
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl, 30);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${manager}::uuid,'WORKFORCE','manager','manager@example.invalid','Manager')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${manager}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${manager}::uuid,${store}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name) VALUES(${product}::uuid,${category}::uuid,'Milk','milk')`.execute(
    db.db,
  );
  inventory = new PostgresInventoryManagement(db.db, new DatabaseIdentityAccess(db.db));
  reservations = new PostgresReservations(db.db);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
test('100 simultaneous attempts against ten units have exactly ten successes and reconcile', async () => {
  const id = await variant();
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'batch',
    quantity: '10',
    reference: uuidV7(),
  });
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((r) => {
    unlock = r;
  });
  const acquired = new Promise<void>((r) => {
    locked = r;
  });
  const blocker = db.db.transaction().execute(async (tx) => {
    await sql`SELECT 1 FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid FOR UPDATE`.execute(
      tx,
    );
    locked();
    await gate;
  });
  await acquired;
  // Each concurrent attempt carries a distinct real order row (007 FK on new reservations).
  const attemptOrderIds = await seedFixtureOrders(100);
  const attempts = attemptOrderIds.map((orderId) => reservations.reserve(input(id, orderId)));
  const observer = new Client({ connectionString: services.databaseUrl });
  await observer.connect();
  const deadline = Date.now() + 5000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const q = await observer.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
    );
    waiting = Number(q.rows[0]!.n);
    if (waiting >= 2) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await observer.end();
  unlock();
  await blocker;
  expect(waiting).toBeGreaterThanOrEqual(2);
  const results = await Promise.allSettled(attempts);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  expect(
    results
      .filter((r) => r.status === 'rejected')
      .every((r) => r.reason.message === 'INVENTORY_INSUFFICIENT'),
  ).toBe(true);
  const totals = await sql<{
    on_hand: string;
    reserved: string;
    batch_on_hand: string;
    batch_reserved: string;
    ledger_on_hand: string;
    ledger_reserved: string;
  }>`SELECT i.on_hand::text,i.reserved::text,(SELECT sum(on_hand)::text FROM inventory_batches WHERE store_id=i.store_id AND variant_id=i.variant_id) batch_on_hand,(SELECT sum(reserved)::text FROM inventory_batches WHERE store_id=i.store_id AND variant_id=i.variant_id) batch_reserved,(SELECT sum(on_hand_delta)::text FROM inventory_ledger WHERE store_id=i.store_id AND variant_id=i.variant_id) ledger_on_hand,(SELECT sum(reserved_delta)::text FROM inventory_ledger WHERE store_id=i.store_id AND variant_id=i.variant_id) ledger_reserved FROM store_inventory i WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(totals.rows[0]).toEqual({
    on_hand: '10',
    reserved: '10',
    batch_on_hand: '10',
    batch_reserved: '10',
    ledger_on_hand: '10',
    ledger_reserved: '10',
  });
}, 30000);
test('FEFO and target shelf life; commit survives sweeper and pick releases shorts', async () => {
  const id = await variant();
  let order = uuidV7();
  await seedFixtureOrders(1).then((ids) => (order = ids[0]!));
  await sql`INSERT INTO inventory_category_shelf_life(category_id,min_seconds) VALUES(${category}::uuid,3600) ON CONFLICT(category_id) DO UPDATE SET min_seconds=EXCLUDED.min_seconds`.execute(
    db.db,
  );
  for (const [code, hours] of [
    ['soon', 2],
    ['late', 8],
  ] as const)
    await inventory.receive(manager, {
      storeId: store,
      variantId: id,
      batchCode: code,
      quantity: '3',
      expiresAt: new Date(Date.now() + hours * 3600000).toISOString(),
      reference: uuidV7(),
    });
  const req = {
    ...input(id, order),
    targetDeliveryAt: new Date(Date.now() + 3 * 3600000).toISOString(),
    lines: [{ storeId: store, variantId: id, quantity: '2' }],
  };
  await reservations.reserve(req);
  await reservations.reserve(req);
  await reservations.commit(order);
  await new InventoryExpiry(db.db).expireHolds();
  const allocations = await sql<{
    batch_code: string;
  }>`SELECT b.batch_code FROM inventory_allocations a JOIN inventory_batches b ON b.id=a.batch_id WHERE a.order_id=${order}::uuid`.execute(
    db.db,
  );
  expect(allocations.rows).toEqual([{ batch_code: 'late' }]);
  await reservations.pick(order, [{ storeId: store, variantId: id, quantity: '1' }]);
  await reservations.pick(order, [{ storeId: store, variantId: id, quantity: '1' }]);
  const stock = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(stock.rows[0]).toEqual({ on_hand: '5', reserved: '0' });
});
test('expired committed allocation is reallocated or a durable shortfall remains without overselling', async () => {
  const id = await variant();
  let order = uuidV7();
  await seedFixtureOrders(1).then((ids) => (order = ids[0]!));
  for (const code of ['first', 'second'])
    await inventory.receive(manager, {
      storeId: store,
      variantId: id,
      batchCode: code,
      quantity: '2',
      expiresAt: new Date(Date.now() + (code === 'first' ? 3 : 8) * 3600000).toISOString(),
      reference: uuidV7(),
    });
  const req = { ...input(id, order), lines: [{ storeId: store, variantId: id, quantity: '2' }] };
  await reservations.reserve(req);
  await reservations.commit(order);
  await sql`UPDATE inventory_batches SET expires_at=clock_timestamp()-interval '1 second' WHERE store_id=${store}::uuid AND variant_id=${id}::uuid AND batch_code='first'`.execute(
    db.db,
  );
  await expect(
    reservations.pick(order, [{ storeId: store, variantId: id, quantity: '2' }]),
  ).rejects.toThrow('INVENTORY_INSUFFICIENT');
  await new InventoryExpiry(db.db).writeOffExpired();
  const allocation = await sql<{
    batch_code: string;
  }>`SELECT b.batch_code FROM inventory_allocations a JOIN inventory_batches b ON b.id=a.batch_id WHERE a.order_id=${order}::uuid`.execute(
    db.db,
  );
  expect(allocation.rows).toEqual([{ batch_code: 'second' }]);
  const stock = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(stock.rows[0]).toEqual({ on_hand: '2', reserved: '2' });
  await reservations.release(order);
});
test('concurrent release and pick resolve exactly once', async () => {
  const id = await variant();
  let order = uuidV7();
  await seedFixtureOrders(1).then((ids) => (order = ids[0]!));
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'one',
    quantity: '1',
    reference: uuidV7(),
  });
  await reservations.reserve(input(id, order));
  await reservations.commit(order);
  const outcomes = await Promise.allSettled([
    reservations.release(order),
    reservations.pick(order, [{ storeId: store, variantId: id, quantity: '1' }]),
  ]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  const stock = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(stock.rows[0]!.reserved).toBe('0');
  expect(['0', '1']).toContain(stock.rows[0]!.on_hand);
});
test('large cycle-count requires a different currently assigned manager and cannot consume reserved units', async () => {
  const { PostgresAdjustments } =
    await import('../../../src/modules/inventory/infrastructure/adjustments.js');
  const { ConfigService } =
    await import('../../../src/modules/app-config/infrastructure/config-service.js');
  const { MakerChecker } =
    await import('../../../src/modules/compliance/infrastructure/maker-checker.js');
  const checker = uuidV7(),
    id = await variant();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${checker}::uuid,'WORKFORCE',${checker},${checker + '@example.invalid'},'Checker')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${checker}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${checker}::uuid,${store}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'count',
    quantity: '150',
    reference: uuidV7(),
  });
  const batch = await sql<{
    id: string;
    version: string;
  }>`SELECT b.id,i.version::text FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.store_id=${store}::uuid AND b.variant_id=${id}::uuid`.execute(
    db.db,
  );
  const counter = new PostgresAdjustments(
    db.db,
    new DatabaseIdentityAccess(db.db),
    new ConfigService(db.db),
    { create: (actions) => new MakerChecker(db.db, actions) },
  );
  const req = {
    storeId: store,
    variantId: id,
    batchId: batch.rows[0]!.id,
    counted: '20',
    expectedVersion: batch.rows[0]!.version,
    reason: 'physical count',
    reference: uuidV7(),
  };
  const approval = await counter.count(manager, req);
  expect(approval.approvalId).toBeDefined();
  expect(await counter.count(manager, req)).toEqual(approval);
  await expect(counter.approve(manager, approval.approvalId!, 'maker-attempt')).rejects.toThrow(
    'APPROVAL_INVALID',
  );
  await sql`DELETE FROM store_staff WHERE user_id=${checker}::uuid AND store_id=${store}::uuid`.execute(
    db.db,
  );
  await expect(counter.approve(checker, approval.approvalId!, 'checker-approval')).rejects.toThrow(
    'FORBIDDEN',
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${checker}::uuid,${store}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await counter.approve(checker, approval.approvalId!, 'checker-approval');
  await counter.approve(checker, approval.approvalId!, 'checker-approval');
  expect(await counter.count(manager, req)).toEqual(approval);
  await expect(counter.count(manager, { ...req, counted: '19' })).rejects.toThrow(
    'IDEMPOTENCY_KEY_REUSED',
  );
  const stock = await sql<{
    on_hand: string;
  }>`SELECT on_hand::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(stock.rows[0]!.on_hand).toBe('20');
});
test('damaged allocated stock records a durable obligation and never violates reserved stock', async () => {
  const { PostgresInventoryQuality } =
    await import('../../../src/modules/inventory/infrastructure/quality.js');
  const id = await variant();
  let order = uuidV7();
  await seedFixtureOrders(1).then((ids) => (order = ids[0]!));
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'damaged',
    quantity: '2',
    reference: uuidV7(),
  });
  await reservations.reserve({
    ...input(id, order),
    lines: [{ storeId: store, variantId: id, quantity: '2' }],
  });
  await reservations.commit(order);
  const batch = await sql<{
    id: string;
  }>`SELECT id FROM inventory_batches WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  const quality = new PostgresInventoryQuality(db.db, new DatabaseIdentityAccess(db.db));
  const req = {
    storeId: store,
    variantId: id,
    batchId: batch.rows[0]!.id,
    state: 'DAMAGED' as const,
    reason: 'broken seal',
    reference: uuidV7(),
  };
  await quality.setState(manager, req);
  await quality.setState(manager, req);
  const obligations = await sql<{
    quantity: string;
  }>`SELECT quantity::text FROM inventory_shortfall_obligations WHERE order_id=${order}::uuid AND resolved_at IS NULL`.execute(
    db.db,
  );
  expect(obligations.rows).toEqual([{ quantity: '2' }]);
  await expect(
    reservations.pick(order, [{ storeId: store, variantId: id, quantity: '2' }]),
  ).rejects.toThrow('INVENTORY_INSUFFICIENT');
  const worker = new InventoryExpiry(db.db);
  await worker.writeOffExpired();
  const operations = await sql<{
    n: string;
  }>`SELECT count(*)::text n FROM inventory_operations WHERE kind='EXPIRY_WRITEOFF'`.execute(db.db);
  await worker.writeOffExpired();
  const again = await sql<{
    n: string;
  }>`SELECT count(*)::text n FROM inventory_operations WHERE kind='EXPIRY_WRITEOFF'`.execute(db.db);
  expect(again.rows[0]).toEqual(operations.rows[0]);
  await reservations.release(order);
  await worker.writeOffExpired();
  const stock = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(stock.rows[0]).toEqual({ on_hand: '0', reserved: '0' });
  const outstanding =
    await sql`SELECT id FROM inventory_shortfall_obligations WHERE order_id=${order}::uuid AND resolved_at IS NULL`.execute(
      db.db,
    );
  expect(outstanding.rows).toHaveLength(0);
});
test('multi-item shortfall rolls back every line and reports missing assortment', async () => {
  const id = await variant(),
    missing = uuidV7();
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'available',
    quantity: '1',
    reference: uuidV7(),
  });
  const req = {
    ...input(id, (await seedFixtureOrders(1))[0]!),
    lines: [
      { storeId: store, variantId: id, quantity: '1' },
      { storeId: store, variantId: missing, quantity: '2' },
    ],
  };
  try {
    await reservations.reserve(req);
    throw new Error('expected failure');
  } catch (e) {
    expect(e).toMatchObject({
      message: 'INVENTORY_INSUFFICIENT',
      shortfalls: [{ storeId: store, variantId: missing, requested: '2', available: '0' }],
    });
  }
  const row = await sql<{
    reserved: string;
  }>`SELECT reserved::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(row.rows[0]!.reserved).toBe('0');
  const partial =
    await sql`SELECT order_id FROM inventory_reservations WHERE order_id=${req.orderId}::uuid`.execute(
      db.db,
    );
  expect(partial.rows).toHaveLength(0);
});
test('store HTTP receipt validates input, replays safely, and isolates assignments', async () => {
  const { createApplication } = await import('../../../src/bootstrap.js');
  const { readEnv } = await import('../../../src/config/env.schema.js');
  const { LocalTokenAdapter } = await import('../../../src/adapters/auth/local.js');
  const id = await variant(),
    env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'store',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      RATE_LIMIT_DEFAULT_PER_MIN: '10000',
    });
  const token = await new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db).issue(
    'WORKFORCE',
    'manager',
    'store',
    'access',
  );
  const app = await createApplication(env);
  try {
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'x'.repeat(150) };
    const payload = { storeId: store, variantId: id, batchCode: 'http', quantity: '3' };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/store/inventory/receipts',
          headers,
          payload: { ...payload, quantity: '1.5' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/store/inventory/receipts',
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/store/inventory/receipts',
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/store/inventory/receipts',
          headers,
          payload: { ...payload, quantity: '4' },
        })
      ).statusCode,
    ).toBe(409);
    const page = await server.inject({
      method: 'GET',
      url: `/v1/store/inventory?storeId=${store}&search=${id}`,
      headers,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().items).toHaveLength(1);
    const forbidden = await server.inject({
      method: 'GET',
      url: `/v1/store/inventory?storeId=${uuidV7()}`,
      headers,
    });
    expect(forbidden.statusCode).toBe(404);
  } finally {
    await app.close();
  }
}, 30000);
test('opposite line orders serialize without deadlock and never leave a partial reservation', async () => {
  const a = await variant(),
    b = await variant();
  for (const variantId of [a, b])
    await inventory.receive(manager, {
      storeId: store,
      variantId,
      batchCode: 'single',
      quantity: '1',
      reference: uuidV7(),
    });
  const lines = [
    { storeId: store, variantId: a, quantity: '1' },
    { storeId: store, variantId: b, quantity: '1' },
  ];
  // Sorted vs reversed line inputs for two distinct real order fixtures.
  const [orderOne, orderTwo] = await seedFixtureOrders(2);
  const outcomes = await Promise.allSettled([
    reservations.reserve({ ...input(a, orderOne!), lines }),
    reservations.reserve({ ...input(a, orderTwo!), lines: [...lines].reverse() }),
  ]);
  expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  const stocks = await sql<{
    reserved: string;
  }>`SELECT reserved::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=ANY(${[a, b]}::uuid[])`.execute(
    db.db,
  );
  expect(stocks.rows.map((v) => v.reserved)).toEqual(['1', '1']);
});
test('commit versus hold expiry resolves to exactly one terminal path', async () => {
  const id = await variant();
  let order = uuidV7();
  await seedFixtureOrders(1).then((ids) => (order = ids[0]!));
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'ttl',
    quantity: '1',
    reference: uuidV7(),
  });
  await reservations.reserve({ ...input(id, order), ttlSeconds: 1 });
  await sql`UPDATE inventory_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE order_id=${order}::uuid`.execute(
    db.db,
  );
  const worker = new InventoryExpiry(db.db);
  const outcomes = await Promise.allSettled([reservations.commit(order), worker.expireHolds()]);
  expect(outcomes[0]!.status).toBe('rejected');
  await worker.expireHolds(); // A busy order is recovered on the next sweep.
  const state = await sql<{
    state: string;
    reserved: string;
  }>`SELECT r.state,i.reserved::text FROM inventory_reservations r JOIN store_inventory i ON i.store_id=r.store_id AND i.variant_id=r.variant_id WHERE r.order_id=${order}::uuid`.execute(
    db.db,
  );
  expect(state.rows[0]).toEqual({ state: 'RESOLVED', reserved: '0' });
});
test('internal return is bounded by picked units and remains quarantined until QC', async () => {
  const { PostgresInventoryReturns } =
    await import('../../../src/modules/inventory/infrastructure/returns.js');
  const id = await variant();
  let order = uuidV7();
  await seedFixtureOrders(1).then((ids) => (order = ids[0]!));
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'original',
    quantity: '2',
    reference: uuidV7(),
  });
  await reservations.reserve({
    ...input(id, order),
    lines: [{ storeId: store, variantId: id, quantity: '2' }],
  });
  await reservations.commit(order);
  await reservations.pick(order, [{ storeId: store, variantId: id, quantity: '2' }]);
  const returns = new PostgresInventoryReturns(db.db, new DatabaseIdentityAccess(db.db)),
    receipt = {
      returnId: uuidV7(),
      orderId: order,
      storeId: store,
      variantId: id,
      quantity: '1',
      expiresAt: null,
    };
  await returns.receiveReturn(manager, receipt);
  await returns.receiveReturn(manager, receipt);
  const available = async () => {
    const r = await sql<{
      available: string;
    }>`SELECT available::text FROM inventory_saleable_availability WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
      db.db,
    );
    return r.rows[0]!.available;
  };
  expect(await available()).toBe('0');
  await returns.inspectReturn(manager, receipt.returnId, 'APPROVE', 'safe');
  expect(await available()).toBe('1');
  await expect(
    returns.receiveReturn(manager, { ...receipt, returnId: uuidV7(), quantity: '2' }),
  ).rejects.toThrow('RETURN_QUANTITY_EXCEEDED');
  const history = await sql<{
    state: string;
  }>`SELECT h.state FROM inventory_batch_history h JOIN inventory_returns r ON r.batch_id=h.batch_id WHERE r.id=${receipt.returnId}::uuid ORDER BY h.id`.execute(
    db.db,
  );
  expect(history.rows.map((r) => r.state)).toEqual(['QUARANTINED', 'ACTIVE']);
});
test('low-stock and expiry alerts commit with stock and failed mutations emit none', async () => {
  const id = await variant(),
    reference = uuidV7();
  const expiry = new Date(Date.now() + 2 * 86400000).toISOString();
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'soon',
    quantity: '2',
    expiresAt: expiry,
    reference,
  });
  const events = await sql<{
    event_type: string;
  }>`SELECT event_type FROM outbox_events WHERE payload->>'variantId'=${id} AND event_type IN ('inventory.low_stock','inventory.expiry_soon') ORDER BY event_type`.execute(
    db.db,
  );
  expect(events.rows.map((e) => e.event_type)).toEqual([
    'inventory.expiry_soon',
    'inventory.low_stock',
  ]);
  const before = await sql<{
    n: string;
  }>`SELECT count(*)::text n FROM outbox_events WHERE payload->>'variantId'=${id}`.execute(db.db);
  await expect(
    inventory.receive(manager, {
      storeId: store,
      variantId: id,
      batchCode: 'soon',
      quantity: '3',
      expiresAt: expiry,
      reference,
    }),
  ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  const after = await sql<{
    n: string;
  }>`SELECT count(*)::text n FROM outbox_events WHERE payload->>'variantId'=${id}`.execute(db.db);
  expect(after.rows[0]).toEqual(before.rows[0]);
  await new InventoryExpiry(db.db).emitDueAlerts();
  const again = await sql<{
    n: string;
  }>`SELECT count(*)::text n FROM outbox_events WHERE payload->>'variantId'=${id}`.execute(db.db);
  expect(again.rows[0]).toEqual(before.rows[0]);
});
test('manual delta is idempotent, versioned, and written as adjustment', async () => {
  const { PostgresManualAdjustment } =
    await import('../../../src/modules/inventory/infrastructure/manual-adjustment.js');
  const { PostgresAdjustments } =
    await import('../../../src/modules/inventory/infrastructure/adjustments.js');
  const { ConfigService } =
    await import('../../../src/modules/app-config/infrastructure/config-service.js');
  const { MakerChecker } =
    await import('../../../src/modules/compliance/infrastructure/maker-checker.js');
  const id = await variant();
  await inventory.receive(manager, {
    storeId: store,
    variantId: id,
    batchCode: 'delta',
    quantity: '5',
    reference: uuidV7(),
  });
  const row = await sql<{
    id: string;
    version: string;
  }>`SELECT b.id,i.version::text FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.store_id=${store}::uuid AND b.variant_id=${id}::uuid`.execute(
    db.db,
  );
  const access = new DatabaseIdentityAccess(db.db),
    counts = new PostgresAdjustments(db.db, access, new ConfigService(db.db), {
      create: (actions) => new MakerChecker(db.db, actions),
    }),
    manual = new PostgresManualAdjustment(db.db, access, counts);
  const req = {
    storeId: store,
    variantId: id,
    batchId: row.rows[0]!.id,
    delta: '2',
    expectedVersion: row.rows[0]!.version,
    reason: 'physical surplus',
    reference: uuidV7(),
  };
  expect(await manual.adjust(manager, req)).toEqual({});
  expect(await manual.adjust(manager, req)).toEqual({});
  await expect(manual.adjust(manager, { ...req, delta: '3' })).rejects.toThrow(
    'IDEMPOTENCY_KEY_REUSED',
  );
  const result = await sql<{
    on_hand: string;
    kind: string;
  }>`SELECT i.on_hand::text,l.kind FROM store_inventory i JOIN inventory_ledger l ON l.store_id=i.store_id AND l.variant_id=i.variant_id AND l.kind='ADJUSTMENT' WHERE i.store_id=${store}::uuid AND i.variant_id=${id}::uuid`.execute(
    db.db,
  );
  expect(result.rows).toEqual([{ on_hand: '7', kind: 'ADJUSTMENT' }]);
});
test('shelf-life changes require current admin authority, version and durable replay', async () => {
  const { PostgresShelfLife } =
    await import('../../../src/modules/inventory/infrastructure/shelf-life.js');
  const admin = uuidV7(),
    newCategory = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${admin}::uuid,'WORKFORCE',${admin},${admin + '@example.invalid'},'Admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${newCategory}::uuid,'Fresh')`.execute(
    db.db,
  );
  const service = new PostgresShelfLife(db.db, new DatabaseIdentityAccess(db.db));
  const req = {
    categoryId: newCategory,
    minSeconds: 7200,
    expectedVersion: '0',
    reason: 'quality policy',
    reference: uuidV7(),
  };
  await expect(service.set(manager, req)).rejects.toThrow('FORBIDDEN');
  await service.set(admin, req);
  await service.set(admin, req);
  await expect(service.set(admin, { ...req, minSeconds: 1 })).rejects.toThrow(
    'IDEMPOTENCY_KEY_REUSED',
  );
  await expect(service.set(admin, { ...req, reference: uuidV7() })).rejects.toThrow(
    'CONCURRENT_MODIFICATION',
  );
});
test('durable count claims make progress on a two-connection pool and fence conflicting requests', async () => {
  const { PostgresAdjustments } =
    await import('../../../src/modules/inventory/infrastructure/adjustments.js');
  const { ConfigService } =
    await import('../../../src/modules/app-config/infrastructure/config-service.js');
  const { MakerChecker } =
    await import('../../../src/modules/compliance/infrastructure/maker-checker.js');
  const requests: Array<{
    storeId: string;
    variantId: string;
    batchId: string;
    counted: string;
    expectedVersion: string;
    reason: string;
    reference: string;
  }> = [];
  for (let n = 0; n < 20; n++) {
    const id = await variant();
    await inventory.receive(manager, {
      storeId: store,
      variantId: id,
      batchCode: 'pool',
      quantity: '2',
      reference: uuidV7(),
    });
    const row = await sql<{
      id: string;
      version: string;
    }>`SELECT b.id,i.version::text FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.store_id=${store}::uuid AND b.variant_id=${id}::uuid`.execute(
      db.db,
    );
    requests.push({
      storeId: store,
      variantId: id,
      batchId: row.rows[0]!.id,
      counted: '1',
      expectedVersion: row.rows[0]!.version,
      reason: 'pool test',
      reference: uuidV7(),
    });
  }
  const limited = createDatabase(services.databaseUrl, 2, 5000);
  try {
    const service = new PostgresAdjustments(
      limited.db,
      new DatabaseIdentityAccess(limited.db),
      new ConfigService(limited.db),
      { create: (actions) => new MakerChecker(limited.db, actions) },
    );
    const complete = await Promise.all(requests.map((req) => service.count(manager, req)));
    expect(complete).toHaveLength(20);
    expect(complete.every((r) => !r.approvalId)).toBe(true);
    const id = await variant();
    await inventory.receive(manager, {
      storeId: store,
      variantId: id,
      batchCode: 'fence',
      quantity: '150',
      reference: uuidV7(),
    });
    const batch = await sql<{
      id: string;
      version: string;
    }>`SELECT b.id,i.version::text FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.store_id=${store}::uuid AND b.variant_id=${id}::uuid`.execute(
      db.db,
    );
    const large = {
      storeId: store,
      variantId: id,
      batchId: batch.rows[0]!.id,
      counted: '20',
      expectedVersion: batch.rows[0]!.version,
      reason: 'fence test',
      reference: uuidV7(),
    };
    const same = await Promise.all(Array.from({ length: 10 }, () => service.count(manager, large)));
    expect(new Set(same.map((r) => r.approvalId)).size).toBe(1);
    expect(same[0]!.approvalId).toBeDefined();
    await expect(service.count(manager, { ...large, counted: '149' })).rejects.toThrow(
      'IDEMPOTENCY_KEY_REUSED',
    );
    const actual = await sql<{
      on_hand: string;
    }>`SELECT on_hand::text FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${id}::uuid`.execute(
      db.db,
    );
    expect(actual.rows[0]!.on_hand).toBe('150');
    const claims = await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM inventory_count_claims WHERE actor_id=${manager}::uuid AND store_id=${store}::uuid AND reference=${large.reference}`.execute(
      db.db,
    );
    expect(claims.rows[0]!.n).toBe('1');
  } finally {
    await limited.close();
  }
}, 30000);

test('stock cursor pages preserve ordering and reject reuse with a different filter', async () => {
  const first = await inventory.list(manager, store, '', undefined, 1);
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  const second = await inventory.list(manager, store, '', first.nextCursor!, 1);
  expect(second.items).toHaveLength(1);
  const firstId = (first.items[0] as { variantId: string }).variantId;
  const secondId = (second.items[0] as { variantId: string }).variantId;
  expect(firstId < secondId).toBe(true);
  await expect(inventory.list(manager, store, 'changed', first.nextCursor!, 1)).rejects.toThrow(
    'INVALID_PAGE',
  );
  await expect(inventory.list(manager, store, '', 'not-a-cursor', 1)).rejects.toThrow(
    'INVALID_PAGE',
  );
});
