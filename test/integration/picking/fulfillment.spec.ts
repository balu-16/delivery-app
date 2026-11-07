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
import { PostgresPacking } from '../../../src/modules/picking/infrastructure/postgres-packing.js';
import { PostgresPickTasks } from '../../../src/modules/picking/infrastructure/postgres-pick-tasks.js';
import { PostgresPickActions } from '../../../src/modules/picking/infrastructure/postgres-pick-actions.js';
import { PostgresPickViews } from '../../../src/modules/picking/infrastructure/postgres-pick-views.js';
import { PostgresPickCancellation } from '../../../src/modules/picking/infrastructure/postgres-pick-cancellation.js';
import { PickingSlaWorker } from '../../../src/modules/picking/infrastructure/sla-worker.js';
import { OrderConfirmedConsumer } from '../../../src/modules/picking/infrastructure/confirmation-consumer.js';
import type { ConfigService } from '../../../src/config/config.service.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import type { StoreSignals } from '../../../src/modules/stores/contracts/signals.js';
import type {
  FinancialAdjustments,
  OrderFulfillment,
  OrderFulfillmentReads,
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
  packing: PostgresPacking,
  inventory: PostgresInventoryManagement,
  reservations: PostgresReservations,
  consumer: OrderConfirmedConsumer;
const packed: string[] = [];
const observations: { storeId: string; backlog: number; riders: boolean }[] = [];

const settings: Partial<Record<ConfigKey, unknown>> = {
  handoverMaxAttempts: 3,
  handoverLockoutSeconds: 60,
  pickingSlaMinutes: 30,
  maxActivePickTasksPerPicker: 5,
};
const configFake: AppConfig = {
  get: async <K extends ConfigKey>(key: K) => {
    if (!(key in settings)) throw new Error(`unexpected config read: ${key}`);
    return settings[key] as ConfigValues[K];
  },
};
const runtimeFake = {
  get: (key: string) => {
    if (key === 'PICKING_HANDOVER_SECRET') return 'picking-test-secret-0123456789abcdef';
    throw new Error(`unexpected runtime read: ${key}`);
  },
} as unknown as ConfigService;
const fakeFulfillment: OrderFulfillment = {
  startPicking: async () => undefined,
  markPacked: async (orderId) => {
    packed.push(orderId);
  },
};
const fakeAdjustments: FinancialAdjustments = {
  recordShort: async () => ({ refundedPaise: '0', creditNoteRequired: false }),
};
const fakeReads: OrderFulfillmentReads = {
  storeOrders: async () => ({ items: [], nextCursor: null }),
  orderSummary: async () => null,
};
const fakeSignals: StoreSignals = {
  noRiders: async () => false,
  observe: async (storeId, backlog, ridersAvailable) => {
    observations.push({ storeId, backlog, riders: ridersAvailable });
  },
  evaluateDue: async () => 0,
};

async function confirmedOrder(lines: { variantId: string; quantity: string }[]) {
  const order = await emitOrderConfirmed(db, world, lines);
  for (const line of lines)
    await reservations.reserve({
      orderId: order.orderId,
      lines: [{ storeId: world.store, variantId: line.variantId, quantity: line.quantity }],
      targetDeliveryAt: new Date(Date.now() + 600000).toISOString(),
      ttlSeconds: 900,
    });
  await reservations.commit(order.orderId);
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
  const task = await sql<{
    id: string;
  }>`SELECT id FROM pick_tasks WHERE order_id=${order.orderId}::uuid`.execute(db.db);
  return { ...order, taskId: task.rows[0]!.id };
}

async function completeWith(order: { taskId: string }, barcode: string) {
  const task = (
    await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' })
  ).items.find((entry) => entry.id === order.taskId)!;
  const item = task.items[0]!;
  const batches = await sql<{
    id: string;
  }>`SELECT id FROM inventory_allocations WHERE order_id=(SELECT order_id FROM pick_tasks WHERE id=${order.taskId}::uuid) AND variant_id=${item.variantId}::uuid LIMIT 1`.execute(
    db.db,
  );
  await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: barcode, quantity: '1', batchId: batches.rows[0]?.id },
    uuidV7(),
  );
  await picking.complete(world.picker1, order.taskId, uuidV7());
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
  const actions = new PostgresPickActions(
    db.db,
    identity,
    fakeAdmin(),
    new PostgresCatalogLookup(db.db),
    new PostgresSubstitutionSwaps(db.db),
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
    new PostgresPickGuidance(db.db),
    actions,
    new PostgresPickViews(db.db),
    new PostgresIdentityRoster(db.db),
    fakeReads,
    fakeFulfillment,
  );
  packing = new PostgresPacking(db.db, identity, configFake, runtimeFake, fakeFulfillment);
  consumer = new OrderConfirmedConsumer(configFake);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

test('pack requires a completed task, records seal data once and marks the order packed', async () => {
  const v = await world.makeVariant({ barcode: 'P1' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'B',
    quantity: '2',
    reference: uuidV7(),
  });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await expect(
    packing.pack(
      world.picker1,
      order.orderId,
      { bags: '1', sealCode: 'S1', coldChain: false },
      uuidV7(),
    ),
  ).rejects.toThrow('PICK_TASK_NOT_COMPLETE');
  await picking.start(world.picker1, order.taskId, uuidV7());
  await completeWith(order, 'P1');
  const reference = uuidV7();
  const first = await packing.pack(
    world.picker1,
    order.orderId,
    { bags: '2', sealCode: 'S1', coldChain: true },
    reference,
  );
  expect(packed).toContain(order.orderId);
  // Replay with the same reference returns the original record untouched.
  await packing.pack(
    world.picker1,
    order.orderId,
    { bags: '9', sealCode: 'S1', coldChain: false },
    reference,
  );
  const row = await sql<{
    bags: number;
    cold_chain: boolean;
    seal_code: string;
  }>`SELECT bags,cold_chain,seal_code FROM packing_records WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(row.rows[0]).toEqual({ bags: 2, cold_chain: true, seal_code: 'S1' });
  expect(first.packedAt).toBeTruthy();
});

test('handover verification is attempt-limited, lockable and manager override is audited', async () => {
  const v = await world.makeVariant({ barcode: 'H1' });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  // No handover record yet: not ready.
  await expect(
    packing.verify(world.picker1, { orderId: order.orderId, code: '000000' }),
  ).rejects.toThrow('HANDOVER_NOT_READY');
  await packing.issue({ orderId: order.orderId, storeId: world.store });
  // Cannot hand over before packing.
  await expect(
    packing.verify(world.picker1, { orderId: order.orderId, code: '000000' }),
  ).rejects.toThrow('HANDOVER_NOT_READY');
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  await completeWith(order, 'H1');
  await packing.pack(
    world.picker1,
    order.orderId,
    { bags: '1', sealCode: 'S', coldChain: false },
    uuidV7(),
  );
  const { code, keyVersion } = await packing.presentCode(order.orderId);
  expect(keyVersion).toBe(1);
  // Wrong codes consume attempts; the third locks the record.
  await expect(
    packing.verify(world.picker1, { orderId: order.orderId, code: '999999' }),
  ).rejects.toThrow('HANDOVER_CODE_INVALID');
  await expect(
    packing.verify(world.picker1, { orderId: order.orderId, code: '999998' }),
  ).rejects.toThrow('HANDOVER_CODE_INVALID');
  await expect(
    packing.verify(world.picker1, { orderId: order.orderId, code: '999997' }),
  ).rejects.toThrow('HANDOVER_CODE_INVALID');
  await expect(packing.verify(world.picker1, { orderId: order.orderId, code })).rejects.toThrow(
    'HANDOVER_LOCKED',
  );
  const locked = await sql<{
    attempts: number;
    locked_until: Date | null;
    state: string;
  }>`SELECT attempts,locked_until,state FROM handover_records WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(locked.rows[0]!.attempts).toBe(3);
  expect(locked.rows[0]!.locked_until).toBeTruthy();
  expect(locked.rows[0]!.state).toBe('PENDING');
  // Manager override bypasses the lock with an audited reason; PICKERs cannot override.
  await expect(
    packing.verify(world.picker1, { orderId: order.orderId, override: true, reason: 'code lost' }),
  ).rejects.toThrow('FORBIDDEN');
  const override = await packing.verify(world.manager, {
    orderId: order.orderId,
    override: true,
    reason: 'code lost',
  });
  expect(override.state).toBe('OVERRIDE');
  const audit = await sql<{
    action: string;
  }>`SELECT action FROM audit_log WHERE subject_type='order' AND subject_id=${order.orderId}`.execute(
    db.db,
  );
  expect(audit.rows.map((row) => row.action)).toContain('picking.handover_override');
  // Verification is idempotent after override.
  expect(
    (
      await packing.verify(world.manager, {
        orderId: order.orderId,
        override: true,
        reason: 'again',
      })
    ).state,
  ).toBe('OVERRIDE');
});

test('a fresh record verifies the derived code and accepts exactly the right code', async () => {
  const v = await world.makeVariant({ barcode: 'H2' });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  await packing.issue({ orderId: order.orderId, storeId: world.store });
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  await completeWith(order, 'H2');
  await packing.pack(
    world.picker1,
    order.orderId,
    { bags: '1', sealCode: 'S', coldChain: false },
    uuidV7(),
  );
  const { code, keyVersion } = await packing.presentCode(order.orderId);
  expect(keyVersion).toBe(1);
  expect(code).toMatch(/^[0-9]{6}$/);
  const verified = await packing.verify(world.picker1, { orderId: order.orderId, code });
  expect(verified.state).toBe('VERIFIED');
});

test('an all-short task goes through the shared cancel routine and never completes', async () => {
  const v = await world.makeVariant({ barcode: 'A2' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'B',
    quantity: '1',
    reference: uuidV7(),
  });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  const shorted = await picking.shortItem(
    world.picker1,
    order.taskId,
    item.id,
    { reason: 'EXPIRED' },
    uuidV7(),
  );
  expect(shorted.items[0]!.status).toBe('SHORT');
  const done = await picking.complete(world.picker1, order.taskId, uuidV7());
  // The shared routine (P6) compensated the order and cancelled the task.
  expect(done.status).toBe('CANCELLED');
  const stock = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${v}::uuid`.execute(
    db.db,
  );
  // No stock was consumed; the committed reservation is released by the P6 compensation.
  expect(stock.rows[0]!.on_hand).toBe('1');
  const history = await sql<{
    status: string;
  }>`SELECT status FROM pick_task_history WHERE task_id=${order.taskId}::uuid ORDER BY version DESC LIMIT 1`.execute(
    db.db,
  );
  expect(history.rows[0]!.status).toBe('CANCELLED');
});

test('the SLA worker records breaches once and passes rider availability through', async () => {
  const v = await world.makeVariant({ barcode: 'S1' });
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  await sql`UPDATE pick_tasks SET sla_due_at=clock_timestamp() - interval '5 minutes' WHERE id=${order.taskId}::uuid`.execute(
    db.db,
  );
  const worker = new PickingSlaWorker(db.db, fakeSignals);
  const first = await worker.runOnce();
  expect(first.breaches).toBeGreaterThanOrEqual(1);
  const second = await worker.runOnce();
  const breaches = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM picking_sla_breaches WHERE task_id=${order.taskId}::uuid`.execute(
    db.db,
  );
  expect(breaches.rows[0]!.count).toBe('1');
  expect(second.breaches).toBe(0);
  const event = await sql<{
    event_type: string;
  }>`SELECT event_type FROM outbox_events WHERE aggregate_type='pick_task' AND aggregate_id=${order.taskId}::uuid AND event_type='picking.sla_breached'`.execute(
    db.db,
  );
  expect(event.rows).toHaveLength(1);
  const observation = observations.find((entry) => entry.storeId === world.store);
  expect(observation).toBeTruthy();
  expect(observation!.riders).toBe(true);
  const kpis = await new PostgresPickViews(db.db).kpis(world.store);
  expect(kpis.slaBreachesToday).toBeGreaterThanOrEqual(1);
});

test('substitution guards fail closed and a listed swap reconciles reservations', async () => {
  const original = await world.makeVariant({ barcode: 'O2' });
  const replacement = await world.makeVariant({ barcode: 'R2' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: original,
    batchCode: 'B',
    quantity: '2',
    reference: uuidV7(),
  });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: replacement,
    batchCode: 'B',
    quantity: '2',
    reference: uuidV7(),
  });
  await sql`INSERT INTO substitute_candidates(variant_id,candidate_variant_id) VALUES(${original}::uuid,${replacement}::uuid)`.execute(
    db.db,
  );
  const order = await confirmedOrder([{ variantId: original, quantity: '1' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  // Unlisted candidate is rejected even with the flag on.
  const stranger = await world.makeVariant({ barcode: 'X2' });
  await expect(
    picking.substituteItem(
      world.picker1,
      order.taskId,
      item.id,
      { candidateVariantId: stranger, scannedBarcode: 'X2' },
      uuidV7(),
    ),
  ).rejects.toThrow('SUBSTITUTION_NOT_PERMITTED');
  // Wrong barcode for the candidate fails closed.
  await expect(
    picking.substituteItem(
      world.picker1,
      order.taskId,
      item.id,
      { candidateVariantId: replacement, scannedBarcode: 'O2' },
      uuidV7(),
    ),
  ).rejects.toThrow('WRONG_ITEM');
  const swapped = await picking.substituteItem(
    world.picker1,
    order.taskId,
    item.id,
    { candidateVariantId: replacement, scannedBarcode: 'R2' },
    uuidV7(),
  );
  expect(swapped.items[0]!.status).toBe('SUBSTITUTED');
  expect(swapped.items[0]!.substituteVariantId).toBe(replacement);
  const stock = await sql<{
    variant: string;
    on_hand: string;
    reserved: string;
  }>`SELECT v.id::text AS variant,i.on_hand::text,i.reserved::text FROM store_inventory i JOIN catalog_variants v ON v.id=i.variant_id WHERE i.store_id=${world.store}::uuid AND i.variant_id IN (${original}::uuid,${replacement}::uuid)`.execute(
    db.db,
  );
  const originalRow = stock.rows.find((row) => row.variant === original)!;
  const replacementRow = stock.rows.find((row) => row.variant === replacement)!;
  expect(originalRow.reserved).toBe('0');
  expect(replacementRow.reserved).toBe('1');
  await picking.complete(world.picker1, order.taskId, uuidV7());
  const after = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${replacement}::uuid`.execute(
    db.db,
  );
  expect(after.rows[0]).toEqual({ on_hand: '1', reserved: '0' });
});
