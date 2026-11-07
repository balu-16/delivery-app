import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { consumeOnce } from '../../../src/platform/events/consume.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresIdentityRoster } from '../../../src/modules/identity/infrastructure/roster.js';
import { PostgresCatalogLookup } from '../../../src/modules/catalog/infrastructure/lookup.js';
import { PostgresReservations } from '../../../src/modules/inventory/infrastructure/reservations.js';
import { PostgresSubstitutionSwaps } from '../../../src/modules/inventory/infrastructure/substitution-swap.js';
import { PostgresPickGuidance } from '../../../src/modules/inventory/infrastructure/pick-guidance.js';
import { PostgresInventoryManagement } from '../../../src/modules/inventory/infrastructure/management.js';
import { PostgresPickTasks } from '../../../src/modules/picking/infrastructure/postgres-pick-tasks.js';
import { PostgresPickActions } from '../../../src/modules/picking/infrastructure/postgres-pick-actions.js';
import { PostgresPickViews } from '../../../src/modules/picking/infrastructure/postgres-pick-views.js';
import { PostgresPickCancellation } from '../../../src/modules/picking/infrastructure/postgres-pick-cancellation.js';
import { OrderConfirmedConsumer } from '../../../src/modules/picking/infrastructure/confirmation-consumer.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import type {
  FinancialAdjustments,
  OrderFulfillment,
  OrderFulfillmentReads,
  ShortAdjustmentLine,
} from '../../../src/modules/picking/contracts/fulfillment.js';
import {
  emitOrderConfirmed,
  envelopeOf,
  fakeAdmin,
  seedPickingWorld,
  type PickingWorld,
} from '../../helpers/picking-fixture.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices,
  db: DatabaseHandle,
  world: PickingWorld,
  picking: PostgresPickTasks,
  inventory: PostgresInventoryManagement,
  reservations: PostgresReservations,
  consumer: OrderConfirmedConsumer;
const fulfillmentCalls: string[] = [];
const adjustmentLines: ShortAdjustmentLine[] = [];

const settings: Partial<Record<ConfigKey, unknown>> = {
  maxActivePickTasksPerPicker: 2,
  pickingSlaMinutes: 30,
};
const configFake: AppConfig = {
  get: async <K extends ConfigKey>(key: K) => {
    if (!(key in settings)) throw new Error(`unexpected config read: ${key}`);
    return settings[key] as ConfigValues[K];
  },
};
const fakeFulfillment: OrderFulfillment = {
  startPicking: async (orderId) => {
    fulfillmentCalls.push(`start:${orderId}`);
  },
  markPacked: async (orderId) => {
    fulfillmentCalls.push(`packed:${orderId}`);
  },
};
const fakeAdjustments: FinancialAdjustments = {
  recordShort: async (input) => {
    adjustmentLines.push(...input.lines);
    return { refundedPaise: '0', creditNoteRequired: false };
  },
};
const fakeReads: OrderFulfillmentReads = {
  storeOrders: async () => ({ items: [], nextCursor: null }),
  orderSummary: async () => null,
};

async function confirmedOrder(lines: { variantId: string; quantity: string }[], ttl = 900) {
  const order = await emitOrderConfirmed(db, world, lines);
  for (const line of lines)
    await reservations.reserve({
      orderId: order.orderId,
      lines: [{ storeId: world.store, variantId: line.variantId, quantity: line.quantity }],
      targetDeliveryAt: new Date(Date.now() + 600000).toISOString(),
      ttlSeconds: ttl,
    });
  await reservations.commit(order.orderId);
  const event = await sql<{
    id: string;
    payload: unknown;
  }>`SELECT id,payload FROM outbox_events WHERE id=${order.eventId}::uuid`.execute(db.db);
  await consumeOnce(db.db, order.eventId, 'picking', async (tx) =>
    consumer.handle(
      tx,
      envelopeOf({
        eventId: order.eventId,
        eventType: 'ORDER_CONFIRMED',
        aggregateId: order.orderId,
        payload: event.rows[0]!.payload,
      }),
    ),
  );
  const task = await sql<{
    id: string;
  }>`SELECT id FROM pick_tasks WHERE order_id=${order.orderId}::uuid`.execute(db.db);
  return { ...order, taskId: task.rows[0]!.id };
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
  world = await seedPickingWorld(db);
  const identity = new DatabaseIdentityAccess(db.db);
  inventory = new PostgresInventoryManagement(db.db, identity);
  reservations = new PostgresReservations(db.db);
  const lookup = new PostgresCatalogLookup(db.db);
  const swaps = new PostgresSubstitutionSwaps(db.db);
  const guidance = new PostgresPickGuidance(db.db);
  const actions = new PostgresPickActions(
    db.db,
    identity,
    fakeAdmin(),
    lookup,
    swaps,
    reservations,
    fakeAdjustments,
    {
      systemCancel: async (orderId, reason, tx) => {
        await new PostgresPickCancellation(db.db).cancel(orderId, reason, tx);
      },
    },
  );
  picking = new PostgresPickTasks(
    db.db,
    identity,
    configFake,
    guidance,
    actions,
    new PostgresPickViews(db.db),
    new PostgresIdentityRoster(db.db),
    fakeReads,
    fakeFulfillment,
  );
  consumer = new OrderConfirmedConsumer(configFake);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

test('the confirmation consumer creates exactly one task per order with walk-ordered items', async () => {
  const v1 = await world.makeVariant({ barcode: '8901001', bin: 'A1' });
  const v2 = await world.makeVariant({ barcode: '8901002', bin: 'B2' });
  const order = await confirmedOrder([
    { variantId: v2, quantity: '2' },
    { variantId: v1, quantity: '3' },
  ]);
  const task = await picking.queue(world.manager, { storeId: world.store, scope: 'QUEUE' });
  expect(task.items).toHaveLength(1);
  expect(task.items[0]!.id).toBe(order.taskId);
  expect(task.items[0]!.items.map((item) => item.name)).toEqual([
    `item-${v2.slice(0, 8)}`,
    `item-${v1.slice(0, 8)}`,
  ]);
  // Duplicate delivery replays to a no-op.
  const event = await sql<{
    payload: unknown;
  }>`SELECT payload FROM outbox_events WHERE id=${order.eventId}::uuid`.execute(db.db);
  await consumeOnce(db.db, order.eventId, 'picking', async (tx) =>
    consumer.handle(
      tx,
      envelopeOf({
        eventId: order.eventId,
        eventType: 'ORDER_CONFIRMED',
        aggregateId: order.orderId,
        payload: event.rows[0]!.payload,
      }),
    ),
  );
  const count = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM pick_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(count.rows[0]!.count).toBe('1');
});

test('claim and start serialize, startPicking fires through the fulfillment contract', async () => {
  const v = await world.makeVariant({ barcode: '8901010' });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  const claimed = await picking.claim(world.picker1, order.taskId, uuidV7());
  expect(claimed.task.status).toBe('ASSIGNED');
  expect(claimed.task.assignedTo).toBe(world.picker1);
  const started = await picking.start(world.picker1, order.taskId, uuidV7());
  expect(started.status).toBe('IN_PROGRESS');
  expect(fulfillmentCalls).toContain(`start:${order.orderId}`);
  // Reassignment keeps progress and returns the task to ASSIGNED.
  const moved = await picking.reassign(
    world.manager,
    order.taskId,
    world.picker2,
    'shift end',
    uuidV7(),
  );
  expect(moved.status).toBe('ASSIGNED');
  expect(moved.assignedTo).toBe(world.picker2);
  expect(moved.items[0]!.status).toBe('PENDING');
  await picking.start(world.picker2, order.taskId, uuidV7());
  // Wrong scan fails closed; the expected barcode resolves the variant.
  const item = moved.items[0]!;
  await expect(
    picking.pickItem(
      world.picker2,
      order.taskId,
      item.id,
      { scannedBarcode: 'nope', quantity: '1' },
      uuidV7(),
    ),
  ).rejects.toThrow('WRONG_ITEM');
  const picked = await picking.pickItem(
    world.picker2,
    order.taskId,
    item.id,
    { scannedBarcode: '8901010', quantity: '1' },
    uuidV7(),
  );
  expect(picked.items[0]!.status).toBe('PICKED');
  expect(picked.items[0]!.pickedQty).toBe('1');
});

test('absolute pick quantities are idempotent per reference and cumulative across retries', async () => {
  const v = await world.makeVariant({ barcode: '8901011' });
  const order = await confirmedOrder([{ variantId: v, quantity: '5' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  const reference = uuidV7();
  await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: '8901011', quantity: '2' },
    reference,
  );
  await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: '8901011', quantity: '2' },
    reference,
  );
  const after = await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: '8901011', quantity: '2' },
    uuidV7(),
  );
  expect(after.items[0]!.pickedQty).toBe('2');
  const more = await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: '8901011', quantity: '5' },
    uuidV7(),
  );
  expect(more.items[0]!.pickedQty).toBe('5');
  await expect(
    picking.pickItem(
      world.picker1,
      order.taskId,
      item.id,
      { scannedBarcode: '8901011', quantity: '6' },
      uuidV7(),
    ),
  ).rejects.toThrow('INVALID_QUANTITY');
});

test('batched variants require the allocated batch and reject foreign batches', async () => {
  const v = await world.makeVariant({ barcode: '8901012' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'B1',
    quantity: '5',
    reference: uuidV7(),
  });
  const order = await confirmedOrder([{ variantId: v, quantity: '2' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  expect(item.fefoSuggestions).toHaveLength(1);
  expect(item.fefoSuggestions[0]!.batchCode).toBe('B1');
  await expect(
    picking.pickItem(
      world.picker1,
      order.taskId,
      item.id,
      { scannedBarcode: '8901012', quantity: '2' },
      uuidV7(),
    ),
  ).rejects.toThrow('BATCH_REQUIRED');
  const other = uuidV7();
  await expect(
    picking.pickItem(
      world.picker1,
      order.taskId,
      item.id,
      { scannedBarcode: '8901012', quantity: '2', batchId: other },
      uuidV7(),
    ),
  ).rejects.toThrow('INVALID_BATCH');
  const batchId = item.fefoSuggestions[0]!.batchId;
  const picked = await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: '8901012', quantity: '2', batchId },
    uuidV7(),
  );
  expect(picked.items[0]!.status).toBe('PICKED');
});

test('FEFO suggestions order by earliest expiry and exclude expired batches', async () => {
  const v = await world.makeVariant({ barcode: '8901013' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'LATE',
    quantity: '4',
    reference: uuidV7(),
    expiresAt: new Date(Date.now() + 7200000).toISOString(),
  });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'EARLY',
    quantity: '4',
    reference: uuidV7(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'STALE',
    quantity: '4',
    reference: uuidV7(),
    expiresAt: new Date(Date.now() - 3600000).toISOString(),
  });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  expect(item.fefoSuggestions.map((batch) => batch.batchCode)).toEqual(['EARLY', 'LATE']);
});

test('shorts mark the remainder, completion consumes picked stock and reports the adjustment once', async () => {
  const v1 = await world.makeVariant({ barcode: '8901014' });
  const v2 = await world.makeVariant({ barcode: '8901015' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v1,
    batchCode: 'B',
    quantity: '4',
    reference: uuidV7(),
  });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v2,
    batchCode: 'B',
    quantity: '4',
    reference: uuidV7(),
  });
  const order = await confirmedOrder([
    { variantId: v1, quantity: '4' },
    { variantId: v2, quantity: '2' },
  ]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const items = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items;
  const first = items.find((item) => item.name === `item-${v1.slice(0, 8)}`)!;
  const second = items.find((item) => item.name === `item-${v2.slice(0, 8)}`)!;
  const batch1 = first.fefoSuggestions[0]!.batchId;
  await picking.pickItem(
    world.picker1,
    order.taskId,
    first.id,
    { scannedBarcode: '8901014', quantity: '2', batchId: batch1 },
    uuidV7(),
  );
  // Completion requires every item resolved.
  await expect(picking.complete(world.picker1, order.taskId, uuidV7())).rejects.toThrow(
    'PICK_TASK_INCOMPLETE',
  );
  const batch2 = second.fefoSuggestions[0]?.batchId;
  const picked2 = await picking.pickItem(
    world.picker1,
    order.taskId,
    second.id,
    { scannedBarcode: '8901015', quantity: '1', batchId: batch2 },
    uuidV7(),
  );
  expect(picked2.items.find((item) => item.id === second.id)!.pickedQty).toBe('1');
  const shorted = await picking.shortItem(
    world.picker1,
    order.taskId,
    second.id,
    { reason: 'DAMAGED' },
    uuidV7(),
  );
  expect(shorted.items.find((item) => item.id === second.id)!.status).toBe('SHORT');
  adjustmentLines.length = 0;
  const done = await picking.complete(world.picker1, order.taskId, uuidV7());
  expect(done.status).toBe('COMPLETED');
  expect(adjustmentLines).toEqual([
    { orderItemId: second.orderItemId, shortQty: '1', reason: 'DAMAGED' },
  ]);
  // Stock reconciles: picked units consumed, shorts released.
  const stock = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${v1}::uuid`.execute(
    db.db,
  );
  expect(stock.rows[0]).toEqual({ on_hand: '2', reserved: '0' });
  const stock2 = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${v2}::uuid`.execute(
    db.db,
  );
  expect(stock2.rows[0]).toEqual({ on_hand: '3', reserved: '0' });
  const ledger = await sql<{
    kind: string;
  }>`SELECT kind FROM inventory_ledger WHERE store_id=${world.store}::uuid AND variant_id=${v1}::uuid ORDER BY created_at`.execute(
    db.db,
  );
  expect(ledger.rows.map((row) => row.kind)).toEqual(['RECEIPT', 'RESERVE', 'RESERVE_COMMIT_PICK']);
  // Completion is idempotent: replay reports the completed task without new adjustments.
  adjustmentLines.length = 0;
  const replay = await picking.complete(world.picker1, order.taskId, uuidV7());
  expect(replay.status).toBe('COMPLETED');
  expect(adjustmentLines).toHaveLength(0);
});
