import { OrderCodeService } from '../../../src/modules/orders/infrastructure/delivery-codes.js';
import { LocalPrivateUploads } from '../../../src/adapters/storage/local-private.js';
import { DeliveryPodMedia } from '../../../src/modules/dispatch/infrastructure/pod-media.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import {
  createDatabase,
  type DatabaseHandle,
  type Json,
} from '../../../src/platform/database/database.js';
import { consumeOnce } from '../../../src/platform/events/consume.js';
import { envSchema } from '../../../src/config/env.schema.js';
import { ConfigService } from '../../../src/config/config.service.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresPacking } from '../../../src/modules/picking/infrastructure/postgres-packing.js';
import { PostgresRiderCash } from '../../../src/modules/riders/infrastructure/postgres-rider-cash.js';
import { PostgresRiderEarnings } from '../../../src/modules/riders/infrastructure/postgres-rider-earnings.js';
import { earningsDefaults } from '../../../src/modules/riders/domain/earnings.js';
import { PostgresRiderEligibility } from '../../../src/modules/riders/infrastructure/postgres-eligibility.js';
import { RiderSettings } from '../../../src/modules/riders/infrastructure/settings.js';
import { RedisRiderGeo } from '../../../src/modules/tracking/infrastructure/redis-geo.js';
import {
  ConfigEtaProvider,
  PostgresLocationReads,
} from '../../../src/modules/tracking/infrastructure/postgres-location-reads.js';
import {
  BroadcastRecorder,
  emitConfirmedOrder,
  fakeConfig,
  packOrderForHandover,
  seedDispatchWorld,
  type DispatchWorld,
} from '../../helpers/dispatch-fixture.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { DispatchSettings } from '../../../src/modules/dispatch/infrastructure/settings.js';
import { CanonicalDeliveryCodes } from '../../../src/modules/dispatch/infrastructure/canonical-codes.js';
import { PostgresDeliveryTasks } from '../../../src/modules/dispatch/infrastructure/postgres-delivery-tasks.js';
import { PostgresTaskActions } from '../../../src/modules/dispatch/infrastructure/postgres-task-actions.js';
import { DeliveryTasksFacade } from '../../../src/modules/dispatch/infrastructure/delivery-tasks-facade.js';
import { DispatchEngine } from '../../../src/modules/dispatch/infrastructure/dispatch-engine.js';
import { PostgresCustomerTracking } from '../../../src/modules/dispatch/infrastructure/postgres-customer-tracking.js';
import { OrderConfirmedConsumer } from '../../../src/modules/dispatch/infrastructure/consumers.js';
import { taskRunner } from '../../../src/modules/dispatch/dispatch.module.js';
import { PostgresWrongAddress } from '../../../src/modules/dispatch/infrastructure/wrong-address.js';
import { PostgresOrderAggregate } from '../../../src/modules/orders/infrastructure/postgres-orders.js';
import { OrderService } from '../../../src/modules/orders/infrastructure/order-service.js';
import { OrderIntegrationService } from '../../../src/modules/orders/infrastructure/order-integration.js';
import type {
  OrderDelivery,
  OrderDeliveryReads,
  OrderDeliverySummary,
  OrderSystemCancel,
} from '../../../src/modules/dispatch/contracts/dependencies.js';
import { deriveCode } from '../../../src/modules/orders/infrastructure/code-crypto.js';

const SECRET = 'unit-test-delivery-code-secret-0123';

let services: TestServices,
  db: DatabaseHandle,
  redis: Redis,
  world: DispatchWorld,
  settings: DispatchSettings,
  broadcasts: BroadcastRecorder,
  codes: CanonicalDeliveryCodes,
  tasks: DeliveryTasksFacade,
  tracking: PostgresCustomerTracking,
  packing: PostgresPacking,
  consumer: OrderConfirmedConsumer;

const deliveredOrders: string[] = [];
const failedOrders: { orderId: string; reason: string }[] = [];
const systemCancels: { orderId: string; reason: string }[] = [];

const orderDelivery: OrderDelivery = {
  markReturnedToStore: async () => undefined,
  markPickedUp: async () => undefined,
  markDelivered: async (orderId, _actor, tx) => {
    deliveredOrders.push(orderId);
    await sql`UPDATE orders SET status='DELIVERED',delivered_at=clock_timestamp() WHERE id=${orderId}::uuid`.execute(
      tx ?? db.db,
    );
  },
  markDeliveryFailed: async (orderId, _actor, reason, _evidence, tx) => {
    failedOrders.push({ orderId, reason });
    await sql`UPDATE orders SET status='DELIVERY_FAILED' WHERE id=${orderId}::uuid`.execute(
      tx ?? db.db,
    );
  },
};
const orderReads: OrderDeliveryReads = {
  orderSummary: async (orderId) => {
    const rows = await sql<{
      id: string;
      order_number: string;
      user_id: string;
      store_id: string;
      status: string;
      payment_method: string | null;
      amount_due_paise: string;
      tip_paise: string;
      address_snapshot: Record<string, unknown>;
    }>`SELECT id,order_number,user_id,store_id,status,payment_method,amount_due_paise::text AS "amount_due_paise",tip_paise::text AS "tip_paise",address_snapshot FROM orders WHERE id=${orderId}::uuid`.execute(
      db.db,
    );
    const row = rows.rows[0];
    if (!row) return null;
    const address = row.address_snapshot as Record<string, unknown>;
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      userId: row.user_id,
      storeId: row.store_id,
      status: row.status,
      paymentMethod: (row.payment_method as OrderDeliverySummary['paymentMethod']) ?? null,
      amountDuePaise: row.amount_due_paise,
      tipPaise: row.tip_paise,
      addressSnapshot: {
        contactName: typeof address.contactName === 'string' ? address.contactName : undefined,
        contactPhone: typeof address.contactPhone === 'string' ? address.contactPhone : undefined,
        lat: typeof address.lat === 'number' ? address.lat : undefined,
        lng: typeof address.lng === 'number' ? address.lng : undefined,
      },
    };
  },
};
const orderSystemCancel: OrderSystemCancel = {
  systemCancel: async (orderId, reason) => {
    systemCancels.push({ orderId, reason });
    await sql`UPDATE orders SET status='CANCELLED',cancelled_at=clock_timestamp() WHERE id=${orderId}::uuid`.execute(
      db.db,
    );
  },
};

async function confirmOrder(options?: Parameters<typeof emitConfirmedOrder>[2]) {
  const order = await emitConfirmedOrder(db, world, options);
  // Drive the confirmation consumer over the fixture event, as the relay will.
  const event = await sql<{
    payload: unknown;
  }>`SELECT payload FROM outbox_events WHERE id=${order.eventId}::uuid`.execute(db.db);
  await consumeOnce(db.db, order.eventId, 'dispatch', async (tx) =>
    consumer.handle(tx, {
      eventId: order.eventId,
      eventType: 'ORDER_CONFIRMED',
      schemaVersion: 1,
      aggregateType: 'order',
      aggregateId: order.orderId,
      aggregateVersion: '1',
      occurredAt: new Date().toISOString(),
      correlationId: order.orderId,
      causationId: null,
      payload: event.rows[0]!.payload as Json,
    }),
  );
  return order;
}

async function releaseAndDispatch(orderId: string) {
  const config = fakeConfig();
  const eligibility = new PostgresRiderEligibility(db.db, new RiderSettings(config));
  const engine = new DispatchEngine(
    db.db,
    settings,
    config,
    broadcasts,
    new RedisRiderGeo(redis),
    eligibility,
    orderSystemCancel,
    new (
      await import('../../../src/modules/dispatch/infrastructure/postgres-cancellation.js')
    ).PostgresDeliveryTaskCancellation(db.db, broadcasts),
  );
  await sql`UPDATE delivery_tasks SET next_dispatch_at=clock_timestamp() WHERE order_id=${orderId}::uuid AND status='UNASSIGNED'`.execute(
    db.db,
  );
  const offered = await engine.dispatchOne(orderId);
  expect(offered).toBe('OFFERED');
}

/** Drives a task from accept through picked-up (store handover verified). */
async function custodyToPickedUp(orderId: string) {
  const task = await sql<{
    id: string;
    offered_rider_id: string | null;
  }>`SELECT id,offered_rider_id FROM delivery_tasks WHERE order_id=${orderId}::uuid`.execute(db.db);
  const rider = task.rows[0]!.offered_rider_id!;
  const offer = await sql<{
    id: string;
  }>`SELECT id FROM rider_offers WHERE task_id=${task.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  const view = await tasks.accept(rider, offer.rows[0]!.id, uuidV7());
  await tasks.arrivedAtStore(rider, view.id, uuidV7());
  await packOrderForHandover(db, world, orderId);
  const presented = await packing.presentCode(orderId);
  await packing.verify(world.manager, { orderId, code: presented.code });
  await tasks.pickedUp(rider, view.id, uuidV7());
  return { rider, taskId: view.id };
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
  redis = new Redis(services.redisUrl, { lazyConnect: false });
  world = await seedDispatchWorld(db);
  const config = fakeConfig();
  settings = new DispatchSettings(config);
  broadcasts = new BroadcastRecorder();
  codes = new CanonicalDeliveryCodes(
    new OrderCodeService(
      db.db,
      new ConfigService(envSchema.parse({ PICKING_HANDOVER_SECRET: SECRET })),
      config,
    ),
  );
  const identity = new DatabaseIdentityAccess(db.db);
  const runtime = new ConfigService(envSchema.parse({}));
  packing = new PostgresPacking(db.db, identity, config, runtime, {
    startPicking: async () => undefined,
    markPacked: async () => undefined,
  });
  const riderSettings = new RiderSettings(config);
  const cash = new PostgresRiderCash(db.db, riderSettings);
  const riderEarnings = new PostgresRiderEarnings(db.db, earningsDefaults());
  const locations = new PostgresLocationReads(db.db);
  const eta = new ConfigEtaProvider(async () => ({
    roadFactor: 1.4,
    avgSpeedKph: 20,
    maxMinutes: 60,
  }));
  const deliveryTasks = new PostgresDeliveryTasks(db.db, settings, broadcasts, packing);
  const actions = new PostgresTaskActions(
    db.db,
    settings,
    broadcasts,
    packing,
    orderDelivery,
    orderReads,
    cash,
    riderEarnings,
    codes,
    eta,
    async () => undefined,
    taskRunner(db.db),
  );
  tasks = new DeliveryTasksFacade(deliveryTasks, actions);
  tracking = new PostgresCustomerTracking(db.db, locations, eta, codes);
  consumer = new OrderConfirmedConsumer(config, codes);
  for (const rider of [world.rider1, world.rider2, world.rider3])
    await new RedisRiderGeo(redis).updateMember(
      rider,
      { lat: world.storeLat, lng: world.storeLng, ts: new Date().toISOString() },
      600,
    );
}, 120000);

beforeEach(async () => {
  await sql`UPDATE rider_status SET online=true,active_tasks=0,idle_since=clock_timestamp() - interval '10 minutes',unreachable_since=NULL`.execute(
    db.db,
  );
  await sql`UPDATE rider_offers SET status='EXPIRED' WHERE status='SENT'`.execute(db.db);
  await sql`UPDATE delivery_tasks SET status='CANCELLED',cancel_reason='suite reset',rider_id=NULL,offered_rider_id=NULL WHERE status IN ('UNASSIGNED','OFFERED','ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')`.execute(
    db.db,
  );
  broadcasts.clear();
});

afterAll(async () => {
  await db?.close();
  redis?.disconnect();
  await services?.stop();
}, 120000);

test('the prepaid journey delivers with a verified code, earnings once and released capacity', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  await tasks.arrived(rider, taskId, uuidV7());
  broadcasts.clear();
  const code = deriveCode(SECRET, order.orderId);
  const delivered = await tasks.deliver(rider, taskId, { deliveryCode: code }, uuidV7());
  expect(delivered.status).toBe('DELIVERED');
  expect(delivered.deliveredAt).not.toBeNull();
  expect(deliveredOrders).toContain(order.orderId);
  const capacity = await sql<{
    active_tasks: number;
    idle_since: Date | null;
  }>`SELECT active_tasks,idle_since FROM rider_status WHERE rider_id=${rider}::uuid`.execute(db.db);
  expect(capacity.rows[0]!.active_tasks).toBe(0);
  expect(capacity.rows[0]!.idle_since).not.toBeNull();
  const earnings = await sql<{
    total_paise: string;
    count: string;
  }>`SELECT total_paise::text AS "total_paise",count(*) OVER ()::text AS count FROM rider_earnings WHERE task_id=${taskId}::uuid`.execute(
    db.db,
  );
  // base 3000 + 2 km × 800 + tip 2000 (distance store→customer ≈ 1.57 km rounds to 2)
  expect(earnings.rows).toHaveLength(1);
  expect(BigInt(earnings.rows[0]!.total_paise) > 5000n).toBe(true);
  // Post-commit emissions reach both rooms; terminal state stops the location stream.
  const rooms = broadcasts.events.map((entry) => `${entry.room}:${entry.event}`);
  expect(rooms).toContain(`rider:${rider}:task.updated`);
  expect(rooms).toContain(`order:${order.orderId}:order.status`);
  const deliveredEvent = await sql<{
    event_type: string;
    consumer: string;
  }>`SELECT e.event_type,d.consumer FROM outbox_events e JOIN outbox_deliveries d ON d.event_id=e.id WHERE e.event_type='ORDER_DELIVERED' AND e.correlation_id=${order.orderId}`.execute(
    db.db,
  );
  expect(deliveredEvent.rows.map((row) => row.consumer).sort()).toEqual([
    'invoicing',
    'notifications',
  ]);
  // Replay with a fresh reference cannot re-deliver a terminal task.
  await expect(tasks.deliver(rider, taskId, { deliveryCode: code }, uuidV7())).rejects.toThrow(
    'TASK_STATE_INVALID',
  );
}, 60000);

test('wrong delivery codes are attempt-limited and lock out durably (DSP-04)', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  await tasks.arrived(rider, taskId, uuidV7());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(
      tasks.deliver(rider, taskId, { deliveryCode: '0000' }, uuidV7()).catch((error: unknown) => {
        throw error instanceof Error && error.message === 'DELIVERY_CODE_LOCKED' && attempt === 4
          ? error
          : error;
      }),
    ).rejects.toThrow();
  }
  const attempts = await sql<{
    attempt_count: number;
    locked_at: Date | null;
  }>`SELECT attempt_count,locked_at FROM order_code_verifiers WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(attempts.rows[0]!.attempt_count).toBe(5);
  expect(attempts.rows[0]!.locked_at).not.toBeNull();
  // The correct code no longer helps until an admin resolves the lockout.
  await expect(
    codes.verify(order.orderId, deriveCode(SECRET, order.orderId), rider),
  ).rejects.toThrow('DELIVERY_CODE_LOCKED');
  const state = await sql<{
    status: string;
  }>`SELECT status FROM delivery_tasks WHERE id=${taskId}::uuid`.execute(db.db);
  expect(state.rows[0]!.status).toBe('ARRIVED');
}, 60000);

test('COD collection gates automatic completion; mismatches block delivery (PAY-09)', async () => {
  const order = await confirmOrder({ cod: true, amountDuePaise: '47000' });
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  await tasks.arrived(rider, taskId, uuidV7());
  await expect(
    tasks.deliver(rider, taskId, { deliveryCode: deriveCode(SECRET, order.orderId) }, uuidV7()),
  ).rejects.toThrow('COD_NOT_COLLECTED');
  // The rider records a short collection: flagged, not delivered.
  const collected = await tasks.codCollect(rider, taskId, { amountPaise: '40000' }, uuidV7());
  expect(collected.mismatch).toBe(true);
  await expect(
    tasks.deliver(rider, taskId, { deliveryCode: deriveCode(SECRET, order.orderId) }, uuidV7()),
  ).rejects.toThrow('COD_AMOUNT_MISMATCH');
  const mismatch = await sql<{
    expected_paise: string;
    collected_paise: string;
  }>`SELECT expected_paise::text AS "expected_paise",collected_paise::text AS "collected_paise" FROM cod_mismatches WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(mismatch.rows[0]).toEqual({ expected_paise: '47000', collected_paise: '40000' });
  const state = await sql<{
    status: string;
  }>`SELECT status FROM delivery_tasks WHERE id=${taskId}::uuid`.execute(db.db);
  expect(state.rows[0]!.status).toBe('ARRIVED');
  // The rider corrects the collection; cash ledger holds the corrected amount once.
  const fixed = await tasks.codCollect(rider, taskId, { amountPaise: '47000' }, uuidV7());
  expect(fixed.mismatch).toBe(false);
  await tasks.deliver(rider, taskId, { deliveryCode: deriveCode(SECRET, order.orderId) }, uuidV7());
  const cash = await sql<{
    balance_after: string;
  }>`SELECT balance_after FROM rider_cash_ledger WHERE rider_id=${rider}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`.execute(
    db.db,
  );
  expect(cash.rows[0]!.balance_after).toBe('47000');
  expect(deliveredOrders).toContain(order.orderId);
}, 60000);

test('rider contact is visible only inside the custody window (GEO-04)', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  const contact = await tasks.contact(rider, taskId);
  expect(contact).toEqual({ contactName: 'Test Customer', contactPhone: '+919876543210' });
  // Another rider gets a 404-class error, never the contact data.
  await expect(
    tasks.contact(rider === world.rider2 ? world.rider1 : world.rider2, taskId),
  ).rejects.toThrow('RESOURCE_NOT_FOUND');
  await tasks.arrived(rider, taskId, uuidV7());
  const code = deriveCode(SECRET, order.orderId);
  await tasks.deliver(rider, taskId, { deliveryCode: code }, uuidV7());
  await expect(tasks.contact(rider, taskId)).resolves.toBeNull();
}, 60000);

test('customer tracking snapshots are ownership-scoped and hide terminal locations (RTN-01)', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  const live = await tracking.tracking(order.orderId, world.customer);
  expect(live?.taskStatus).toBe('PICKED_UP');
  expect(live?.riderLocation).not.toBeNull();
  expect(live?.eta).not.toBeNull();
  expect(await tracking.tracking(order.orderId, uuidV7())).toBeNull();
  const code = await tracking.deliveryCode(order.orderId, world.customer);
  expect(code.code).toBe(deriveCode(SECRET, order.orderId));
  await expect(tracking.deliveryCode(order.orderId, uuidV7())).rejects.toThrow(
    'RESOURCE_NOT_FOUND',
  );
  await tasks.arrived(rider, taskId, uuidV7());
  await tasks.deliver(rider, taskId, { deliveryCode: deriveCode(SECRET, order.orderId) }, uuidV7());
  const terminal = await tracking.tracking(order.orderId, world.customer);
  expect(terminal?.taskStatus).toBe('DELIVERED');
  expect(terminal?.riderLocation).toBeNull();
}, 60000);

test('rider-initiated failure before pickup re-dispatches; post-pickup ends FAILED via P6', async () => {
  // Pre-pickup: task returns to the pool with attempt_no+1.
  const pre = await confirmOrder();
  await releaseAndDispatch(pre.orderId);
  const preTask = await custodyToPickedUpStore(pre.orderId);
  const dropped = await tasks.fail(
    preTask.rider,
    preTask.taskId,
    { reason: 'vehicle breakdown' },
    uuidV7(),
  );
  expect(dropped.status).toBe('UNASSIGNED');
  expect(dropped.attemptNo).toBe(1);
  expect(failedOrders).toHaveLength(0);
  // Post-pickup: FAILED with the reason retained and the order transitioned.
  const post = await confirmOrder();
  await releaseAndDispatch(post.orderId);
  const postTask = await custodyToPickedUp(post.orderId);
  await expect(
    tasks.fail(postTask.rider, postTask.taskId, { reason: 'CUSTOMER_UNREACHABLE' }, uuidV7()),
  ).rejects.toThrow('TASK_STATE_INVALID');
  await tasks.arrived(postTask.rider, postTask.taskId, uuidV7());
  await expect(
    tasks.fail(
      postTask.rider,
      postTask.taskId,
      { reason: 'CUSTOMER_UNREACHABLE', evidence: { attempts: '999' } },
      uuidV7(),
    ),
  ).rejects.toThrow('DELIVERY_WAIT_REQUIRED');
  await expect(
    tasks.recordContactAttempt(
      postTask.rider === world.rider3 ? world.rider2 : world.rider3,
      postTask.taskId,
      uuidV7(),
    ),
  ).rejects.toThrow('RESOURCE_NOT_FOUND');
  const reference = uuidV7();
  const attempt = await tasks.recordContactAttempt(postTask.rider, postTask.taskId, reference);
  expect(await tasks.recordContactAttempt(postTask.rider, postTask.taskId, reference)).toEqual(
    attempt,
  );
  await sql`UPDATE delivery_tasks SET arrived_customer_at=clock_timestamp()-interval '6 minutes' WHERE id=${postTask.taskId}::uuid`.execute(
    db.db,
  );
  await expect(
    tasks.fail(
      postTask.rider,
      postTask.taskId,
      { reason: 'CUSTOMER_UNREACHABLE', evidence: { attempts: '999' } },
      uuidV7(),
    ),
  ).rejects.toThrow('DELIVERY_CONTACT_ATTEMPTS_REQUIRED');
  await tasks.recordContactAttempt(postTask.rider, postTask.taskId, uuidV7());
  const failed = await tasks.fail(
    postTask.rider,
    postTask.taskId,
    { reason: 'CUSTOMER_UNREACHABLE', evidence: { attempts: '3' } },
    uuidV7(),
  );
  expect(failed.status).toBe('FAILED');
  expect(failedOrders).toEqual([{ orderId: post.orderId, reason: 'CUSTOMER_UNREACHABLE' }]);
  const stored = await sql<{
    failure_reason: string;
    failure_evidence: Record<string, string>;
  }>`SELECT failure_reason,failure_evidence FROM delivery_tasks WHERE id=${postTask.taskId}::uuid`.execute(
    db.db,
  );
  expect(stored.rows[0]!.failure_reason).toBe('CUSTOMER_UNREACHABLE');
  expect(stored.rows[0]!.failure_evidence).toEqual({ attempts: '3' });
});

test('wrong address requires rider flag and audited admin failure after the wait', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  const aggregate = new PostgresOrderAggregate(db.db);
  const orders = new OrderService(
    db.db,
    aggregate,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const service = new PostgresWrongAddress(
    taskRunner(db.db),
    settings,
    new OrderIntegrationService(orders, aggregate),
    broadcasts,
  );
  const admin = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${admin}::uuid,'WORKFORCE',${admin},${`${admin}@example.invalid`},'admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`UPDATE orders SET status='OUT_FOR_DELIVERY' WHERE id=${order.orderId}::uuid`.execute(
    db.db,
  );
  await expect(service.flag(rider, taskId, 'address mismatch', uuidV7())).rejects.toThrow(
    'TASK_STATE_INVALID',
  );
  await tasks.arrived(rider, taskId, uuidV7());
  const otherRider = rider === world.rider3 ? world.rider2 : world.rider3;
  await expect(service.flag(otherRider, taskId, 'address mismatch', uuidV7())).rejects.toThrow(
    'RESOURCE_NOT_FOUND',
  );
  const flagRef = uuidV7();
  const flag = await service.flag(rider, taskId, 'address mismatch', flagRef);
  expect(await service.flag(rider, taskId, 'address mismatch', flagRef)).toEqual(flag);
  const notification = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM outbox_events e JOIN outbox_deliveries d ON d.event_id=e.id
    WHERE e.event_type='delivery.wrong_address_flagged' AND e.payload->>'flagId'=${flag.flagId} AND d.consumer='notifications'`.execute(
    db.db,
  );
  expect(notification.rows[0]?.n).toBe('1');
  await expect(
    service.resolve(otherRider, order.orderId, 'confirmed wrong address', uuidV7()),
  ).rejects.toThrow('FORBIDDEN');
  await expect(tasks.fail(rider, taskId, { reason: 'WRONG_ADDRESS' }, uuidV7())).rejects.toThrow(
    'ADMIN_RESOLUTION_REQUIRED',
  );
  await expect(
    service.resolve(admin, order.orderId, 'confirmed wrong address', uuidV7()),
  ).rejects.toThrow('DELIVERY_WAIT_REQUIRED');
  await tasks.recordContactAttempt(rider, taskId, uuidV7());
  await sql`UPDATE delivery_tasks SET arrived_customer_at=clock_timestamp()-interval '6 minutes' WHERE id=${taskId}::uuid`.execute(
    db.db,
  );
  await expect(
    service.resolve(admin, order.orderId, 'confirmed wrong address', uuidV7()),
  ).rejects.toThrow('DELIVERY_CONTACT_ATTEMPTS_REQUIRED');
  await tasks.recordContactAttempt(rider, taskId, uuidV7());
  const ref = uuidV7();
  const result = await service.resolve(admin, order.orderId, 'confirmed wrong address', ref);
  expect(result).toEqual({ ...flag, status: 'FAILED' });
  expect(await service.resolve(admin, order.orderId, 'confirmed wrong address', ref)).toEqual(
    result,
  );
  const state = await sql<{
    status: string;
    rider_id: string;
    custody_released_at: Date | null;
  }>`SELECT status,rider_id,custody_released_at FROM delivery_tasks WHERE id=${taskId}::uuid`.execute(
    db.db,
  );
  expect(state.rows[0]).toEqual({ status: 'FAILED', rider_id: rider, custody_released_at: null });
  const history = await sql<{
    actor_type: string;
    actor_id: string;
    state: string;
  }>`SELECT actor_type,actor_id,state FROM order_status_history WHERE order_id=${order.orderId}::uuid AND state='DELIVERY_FAILED'`.execute(
    db.db,
  );
  expect(history.rows).toEqual([
    { actor_type: 'ADMIN', actor_id: admin, state: 'DELIVERY_FAILED' },
  ]);
  const resolution = await sql<{
    resolved_by: string;
    resolution_reason: string;
  }>`SELECT resolved_by,resolution_reason FROM delivery_wrong_address_flags WHERE id=${flag.flagId}::uuid`.execute(
    db.db,
  );
  expect(resolution.rows[0]).toEqual({
    resolved_by: admin,
    resolution_reason: 'confirmed wrong address',
  });
});

/** Accepts and arrives at the store without completing the handover. */
async function custodyToPickedUpStore(orderId: string) {
  const task = await sql<{
    id: string;
    offered_rider_id: string | null;
  }>`SELECT id,offered_rider_id FROM delivery_tasks WHERE order_id=${orderId}::uuid`.execute(db.db);
  const rider = task.rows[0]!.offered_rider_id!;
  const offer = await sql<{
    id: string;
  }>`SELECT id FROM rider_offers WHERE task_id=${task.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  const view = await tasks.accept(rider, offer.rows[0]!.id, uuidV7());
  await tasks.arrivedAtStore(rider, view.id, uuidV7());
  return { rider, taskId: view.id };
}

export { consumeOnce, confirmOrder as confirmOrderInternal };

test('contactless POD requires owned stored media bound to the active task', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const { rider, taskId } = await custodyToPickedUp(order.orderId);
  await tasks.arrived(rider, taskId, uuidV7());
  const dir = await mkdtemp(join(tmpdir(), 'delivery-pod-'));
  try {
    const uploads = new LocalPrivateUploads(db.db, SECRET, dir, 1024, 300, 300);
    const pod = new DeliveryPodMedia(db.db, uploads);
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const target = await pod.target(rider, taskId, 'image/png', body.length);
    await expect(
      tasks.deliver(rider, taskId, { podMediaId: target.mediaId }, uuidV7()),
    ).rejects.toThrow('MEDIA_NOT_FOUND');
    await uploads.upload(target.mediaId, target.fields.authorization!.slice(7), body);
    await pod.complete(rider, taskId, target.mediaId);
    const delivered = await tasks.deliver(rider, taskId, { podMediaId: target.mediaId }, uuidV7());
    expect(delivered.status).toBe('DELIVERED');
    const stored = await sql<{
      pod_media_id: string;
    }>`SELECT pod_media_id FROM delivery_tasks WHERE id=${taskId}::uuid`.execute(db.db);
    expect(stored.rows[0]!.pod_media_id).toBe(target.mediaId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
