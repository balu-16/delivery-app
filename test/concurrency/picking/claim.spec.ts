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
  cancellation: PostgresPickCancellation,
  consumer: OrderConfirmedConsumer;
const adjustmentLines: ShortAdjustmentLine[] = [];

const settings: Partial<Record<ConfigKey, unknown>> = {
  maxActivePickTasksPerPicker: 50,
  pickingSlaMinutes: 30,
};
const configFake: AppConfig = {
  get: async <K extends ConfigKey>(key: K) => {
    if (!(key in settings)) throw new Error(`unexpected config read: ${key}`);
    return settings[key] as ConfigValues[K];
  },
};
const fakeFulfillment: OrderFulfillment = {
  startPicking: async () => undefined,
  markPacked: async () => undefined,
};
const fakeAdjustments: FinancialAdjustments = {
  recordShort: async (input) => {
    adjustmentLines.push(...input.lines);
    return { refundedPaise: '0', creditNoteRequired: false };
  },
};
let pickCancellationForActions: PostgresPickCancellation | undefined;
const fakeReads: OrderFulfillmentReads = {
  storeOrders: async () => ({ items: [], nextCursor: null }),
  orderSummary: async () => null,
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
      // Simulates the P6 contract: the shared cancel routine cancels the task.
      systemCancel: async (orderId, reason, tx) => {
        await (pickCancellationForActions ??= new PostgresPickCancellation(db.db)).cancel(
          orderId,
          reason,
          tx,
        );
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
  cancellation = new PostgresPickCancellation(db.db);
  consumer = new OrderConfirmedConsumer(configFake);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

test('two pickers claiming one task produce exactly one winner', async () => {
  const v = await world.makeVariant();
  const order = await confirmedOrder([{ variantId: v, quantity: '1' }]);
  const attempts = await Promise.allSettled([
    picking.claim(world.picker1, order.taskId, uuidV7()),
    picking.claim(world.picker2, order.taskId, uuidV7()),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter(
    (attempt) =>
      attempt.status === 'rejected' &&
      String(attempt.reason?.message ?? '').includes('PICK_TASK_STATE_INVALID'),
  );
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const row = await sql<{
    status: string;
    assigned_to: string;
  }>`SELECT status,assigned_to FROM pick_tasks WHERE id=${order.taskId}::uuid`.execute(db.db);
  expect(row.rows[0]!.status).toBe('ASSIGNED');
  expect(row.rows[0]!.assigned_to).toBe(world.picker1);
  // A third claimer loses deterministically against the assigned task.
  await expect(picking.claim(world.picker2, order.taskId, uuidV7())).rejects.toThrow(
    'PICK_TASK_STATE_INVALID',
  );
});

test('cancel and pick-complete serialize into one consistent terminal state', async () => {
  const v = await world.makeVariant({ barcode: 'C1' });
  await inventory.receive(world.manager, {
    storeId: world.store,
    variantId: v,
    batchCode: 'B',
    quantity: '2',
    reference: uuidV7(),
  });
  const order = await confirmedOrder([{ variantId: v, quantity: '2' }]);
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  await picking.pickItem(
    world.picker1,
    order.taskId,
    item.id,
    { scannedBarcode: 'C1', quantity: '2', batchId: item.fefoSuggestions[0]!.batchId },
    uuidV7(),
  );
  adjustmentLines.length = 0;
  const [complete, cancel] = await Promise.allSettled([
    picking.complete(world.picker1, order.taskId, uuidV7()),
    cancellation.cancel(order.orderId, 'customer cancel'),
  ]);
  const state = await sql<{
    status: string;
  }>`SELECT status FROM pick_tasks WHERE id=${order.taskId}::uuid`.execute(db.db);
  if (state.rows[0]!.status === 'COMPLETED') {
    expect(complete.status).toBe('fulfilled');
    // Cancellation after completion is a no-op; the loser observes the terminal state.
    expect(['fulfilled', 'rejected']).toContain(cancel.status);
    const stock = await sql<{
      on_hand: string;
      reserved: string;
    }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${v}::uuid`.execute(
      db.db,
    );
    expect(stock.rows[0]!.reserved).toBe('0');
  } else {
    expect(state.rows[0]!.status).toBe('CANCELLED');
    expect(complete.status).toBe('rejected');
    // The committed reservation stays held until the order compensation (P6) releases it.
    const stock = await sql<{
      on_hand: string;
      reserved: string;
    }>`SELECT on_hand::text,reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${v}::uuid`.execute(
      db.db,
    );
    expect(stock.rows[0]!.reserved).toBe('2');
  }
  // No double consumption and no double adjustment either way.
  expect(adjustmentLines.length).toBeLessThanOrEqual(1);
});

test('substitution cannot oversell: exactly one contending reservation wins', async () => {
  const original = await world.makeVariant({ barcode: 'O1' });
  const replacement = await world.makeVariant({ barcode: 'R1' });
  const contender = uuidV7();
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
    quantity: '1',
    reference: uuidV7(),
  });
  const order = await confirmedOrder([{ variantId: original, quantity: '1' }]);
  // A separate confirmed order holds the single replacement unit; it is
  // released just before the two contending acquirers race for it.
  await reservations.reserve({
    orderId: contender,
    lines: [{ storeId: world.store, variantId: replacement, quantity: '1' }],
    targetDeliveryAt: new Date(Date.now() + 600000).toISOString(),
    ttlSeconds: 900,
  });
  await picking.claim(world.picker1, order.taskId, uuidV7());
  await picking.start(world.picker1, order.taskId, uuidV7());
  const item = (await picking.queue(world.picker1, { storeId: world.store, scope: 'MINE' }))
    .items[0]!.items[0]!;
  await reservations.release(contender);
  const [substitute, reReserve] = await Promise.allSettled([
    picking.substituteItem(
      world.picker1,
      order.taskId,
      item.id,
      { candidateVariantId: replacement, scannedBarcode: 'R1' },
      uuidV7(),
    ),
    reservations.reserve({
      orderId: contender,
      lines: [{ storeId: world.store, variantId: replacement, quantity: '1' }],
      targetDeliveryAt: new Date(Date.now() + 600000).toISOString(),
      ttlSeconds: 900,
    }),
  ]);
  const batchSum = await sql<{
    reserved: string;
  }>`SELECT COALESCE(sum(reserved),0)::text AS reserved FROM inventory_batches WHERE store_id=${world.store}::uuid AND variant_id=${replacement}::uuid`.execute(
    db.db,
  );
  expect(BigInt(batchSum.rows[0]!.reserved)).toBeLessThanOrEqual(1n);
  // Exactly one acquirer holds the unit: the loser observes a typed conflict.
  if (substitute.status === 'fulfilled') expect(reReserve.status).toBe('rejected');
  else {
    expect(String((substitute as PromiseRejectedResult).reason?.message ?? '')).toContain(
      'INVENTORY_INSUFFICIENT',
    );
    expect(reReserve.status).toBe('fulfilled');
  }
});
