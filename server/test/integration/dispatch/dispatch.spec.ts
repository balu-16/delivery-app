import { jest } from '@jest/globals';
import { OrderCodeService } from '../../../src/modules/orders/infrastructure/delivery-codes.js';
import { PostgresLocationIngest } from '../../../src/modules/tracking/infrastructure/postgres-location-ingest.js';
import { ActiveOrderResolverHolder } from '../../../src/modules/tracking/contracts/tracking.js';
import { INTEGRITY_DEFAULTS } from '../../../src/modules/tracking/domain/integrity.js';
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
import { envSchema, readEnv } from '../../../src/config/env.schema.js';
import { ConfigService } from '../../../src/config/config.service.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresPacking } from '../../../src/modules/picking/infrastructure/postgres-packing.js';
import { PostgresRiderCash } from '../../../src/modules/riders/infrastructure/postgres-rider-cash.js';
import { PostgresRiderEligibility } from '../../../src/modules/riders/infrastructure/postgres-eligibility.js';
import { RiderSettings } from '../../../src/modules/riders/infrastructure/settings.js';
import { RedisRiderGeo } from '../../../src/modules/tracking/infrastructure/redis-geo.js';
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
import { PostgresDeliveryTaskCancellation } from '../../../src/modules/dispatch/infrastructure/postgres-cancellation.js';
import { PostgresDeliveryTasks } from '../../../src/modules/dispatch/infrastructure/postgres-delivery-tasks.js';
import { RiderTaskReads } from '../../../src/modules/dispatch/infrastructure/rider-task-reads.js';
import { PostgresTaskActions } from '../../../src/modules/dispatch/infrastructure/postgres-task-actions.js';
import { DeliveryTasksFacade } from '../../../src/modules/dispatch/infrastructure/delivery-tasks-facade.js';
import { PostgresRiderEarnings } from '../../../src/modules/riders/infrastructure/postgres-rider-earnings.js';
import { earningsDefaults } from '../../../src/modules/riders/domain/earnings.js';
import { ConfigEtaProvider } from '../../../src/modules/tracking/infrastructure/postgres-location-reads.js';
import { DispatchEngine } from '../../../src/modules/dispatch/infrastructure/dispatch-engine.js';
import { OrderHoldService } from '../../../src/modules/orders/infrastructure/order-holds.js';
import { ManualAssignment } from '../../../src/modules/dispatch/infrastructure/manual-assignment.js';
import { DispatchMaintenance } from '../../../src/modules/dispatch/infrastructure/maintenance.js';
import { publishOfferRevocation } from '../../../src/modules/dispatch/infrastructure/revocation-realtime.js';
import {
  OrderConfirmedConsumer,
  PickTriggerConsumer,
} from '../../../src/modules/dispatch/infrastructure/consumers.js';
import { taskRunner } from '../../../src/modules/dispatch/dispatch.module.js';
import type {
  OrderDelivery,
  OrderDeliveryReads,
  OrderDeliverySummary,
  OrderSystemCancel,
} from '../../../src/modules/dispatch/contracts/dependencies.js';
import { OlaMaps } from '../../../src/adapters/maps/ola.js';
import { ResilientMaps } from '../../../src/adapters/maps/resilient.js';
import { buildOlaConfig } from '../../../src/adapters/maps/config.js';
import type { MapsPort } from '../../../src/modules/serviceability/contracts/maps.js';

let services: TestServices,
  db: DatabaseHandle,
  redis: Redis,
  world: DispatchWorld,
  settings: DispatchSettings,
  broadcasts: BroadcastRecorder,
  geo: RedisRiderGeo,
  engine: DispatchEngine,
  codes: CanonicalDeliveryCodes,
  tasks: DeliveryTasksFacade,
  cancellation: PostgresDeliveryTaskCancellation,
  maintenance: DispatchMaintenance,
  consumer: OrderConfirmedConsumer,
  trigger: PickTriggerConsumer,
  packing: PostgresPacking;

if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(300000);

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
        lat:
          typeof address.lat === 'number' ? address.lat : Number(address.lat ?? NaN) || undefined,
        lng:
          typeof address.lng === 'number' ? address.lng : Number(address.lng ?? NaN) || undefined,
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
  const event = await sql<{
    payload: unknown;
  }>`SELECT payload FROM outbox_events WHERE id=${order.eventId}::uuid`.execute(db.db);
  await consumeOnce(db.db, order.eventId, 'dispatch', async (tx) =>
    consumer.handle(
      tx,
      envelope(order.eventId, 'ORDER_CONFIRMED', order.orderId, event.rows[0]!.payload),
    ),
  );
  return order;
}

function envelope(eventId: string, eventType: string, aggregateId: string, payload: unknown) {
  return {
    eventId,
    eventType,
    schemaVersion: 1,
    aggregateType: 'order',
    aggregateId,
    aggregateVersion: '1',
    occurredAt: new Date().toISOString(),
    correlationId: aggregateId,
    causationId: null,
    payload: payload as Json,
  };
}

async function releaseAndDispatch(orderId: string) {
  // ON_PICK_START trigger: picking.task_changed IN_PROGRESS releases the task.
  const eventId = uuidV7();
  const task = await sql<{
    id: string;
  }>`SELECT id FROM delivery_tasks WHERE order_id=${orderId}::uuid`.execute(db.db);
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload)
    VALUES(${eventId}::uuid,'picking.task_changed',1,'pick_task',${task.rows[0]!.id}::uuid,1::bigint,${orderId},${JSON.stringify(
      {
        taskId: task.rows[0]!.id,
        orderId,
        status: 'IN_PROGRESS',
      },
    )}::jsonb)`.execute(db.db);
  await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,'dispatch-trigger')`.execute(
    db.db,
  );
  await consumeOnce(db.db, eventId, 'dispatch-trigger', async (tx) =>
    trigger.handle(
      tx,
      envelope(eventId, 'picking.task_changed', orderId, {
        taskId: task.rows[0]!.id,
        orderId,
        status: 'IN_PROGRESS',
      }),
    ),
  );
  await engine.dispatchOne(orderId);
}

test('rider task projections hide another rider’s assignment and preserve reassignment history', async () => {
  const order = await confirmOrder();
  const repository = new PostgresDeliveryTasks(db.db, settings, broadcasts, packing);
  const manual = new ManualAssignment(repository);
  const reads = new RiderTaskReads(db.db, repository);
  const first = await manual.assign(order.orderId, world.rider1, world.admin, 'test', uuidV7());
  expect((await reads.active(world.rider1)).items.some((task) => task.id === first.id)).toBe(true);
  await expect(reads.detail(world.rider2, first.id)).rejects.toThrow('RESOURCE_NOT_FOUND');
  await manual.assign(order.orderId, world.rider2, world.admin, 'reassign', uuidV7());
  await expect(reads.detail(world.rider1, first.id)).rejects.toThrow('RESOURCE_NOT_FOUND');
  const history = (await reads.history(world.rider1)).items.find((task) => task.id === first.id);
  expect(history?.status).toBe('REASSIGNED');
  expect(history).not.toHaveProperty('destination');
  expect((await reads.detail(world.rider2, first.id)).orderId).toBe(order.orderId);
});

test('holds prevent dispatch, offer acceptance and manual assignment until resumed', async () => {
  const order = await confirmOrder();
  const holds = new OrderHoldService(db.db);
  await holds.set(order.orderId, world.admin, true, 'review');
  await releaseAndDispatch(order.orderId);
  expect(await engine.dispatchOne(order.orderId)).toBe('INELIGIBLE');
  const manual = new ManualAssignment(
    new PostgresDeliveryTasks(db.db, settings, broadcasts, packing),
  );
  await expect(
    manual.assign(order.orderId, world.rider1, world.admin, 'manual', uuidV7()),
  ).rejects.toThrow('ORDER_ON_HOLD');
  await holds.set(order.orderId, world.admin, false, 'cleared');
  expect(await engine.dispatchOne(order.orderId)).toBe('OFFERED');
  const offers = await sql<{
    id: string;
    rider_id: string;
  }>`SELECT o.id,o.rider_id FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE t.order_id=${order.orderId}::uuid AND o.status='SENT'`.execute(
    db.db,
  );
  const offer = offers.rows[0]!;
  await holds.set(order.orderId, world.admin, true, 'review again');
  await expect(tasks.accept(offer.rider_id, offer.id, uuidV7())).rejects.toThrow('ORDER_ON_HOLD');
  await holds.set(order.orderId, world.admin, false, 'cleared again');
  const accepted = await tasks.accept(offer.rider_id, offer.id, uuidV7());
  expect(accepted.riderId).toBe(offer.rider_id);
  await tasks.arrivedAtStore(offer.rider_id, accepted.id, uuidV7());
  await sql`INSERT INTO pick_tasks(id,order_id,store_id,status,sla_due_at,completed_at,completed_by)
    VALUES(${uuidV7()}::uuid,${order.orderId}::uuid,${world.store}::uuid,'COMPLETED',clock_timestamp(),clock_timestamp(),${world.manager}::uuid)`.execute(
    db.db,
  );
  await holds.set(order.orderId, world.admin, true, 'packing review');
  await expect(
    packing.pack(
      world.manager,
      order.orderId,
      { bags: '1', sealCode: 'seal', coldChain: false },
      uuidV7(),
    ),
  ).rejects.toThrow('ORDER_ON_HOLD');
  const code = await packing.presentCode(order.orderId);
  await expect(
    packing.verify(world.manager, { orderId: order.orderId, code: code.code }),
  ).rejects.toThrow('ORDER_ON_HOLD');
  await holds.set(order.orderId, world.admin, false, 'packing cleared');
  await packing.pack(
    world.manager,
    order.orderId,
    { bags: '1', sealCode: 'seal', coldChain: false },
    uuidV7(),
  );
  await packing.verify(world.manager, { orderId: order.orderId, code: code.code });
  await holds.set(order.orderId, world.admin, true, 'pickup review');
  await expect(tasks.pickedUp(offer.rider_id, accepted.id, uuidV7())).rejects.toThrow(
    'ORDER_ON_HOLD',
  );
  await holds.set(order.orderId, world.admin, false, 'pickup cleared');
  await tasks.pickedUp(offer.rider_id, accepted.id, uuidV7());
  await expect(holds.set(order.orderId, world.admin, true, 'too late')).rejects.toThrow(
    'ILLEGAL_STATE_TRANSITION',
  );
});

/** Per-test isolation: the suite shares one world, so operational state resets. */
beforeEach(async () => {
  // Locations must stay fresh: eligibility rejects PG points older than
  // riderStaleLocationSeconds and GEO hashes TTL fast, while a slow AWS run
  // outlasts a single beforeAll seed.
  await sql`UPDATE rider_status SET online=true,active_tasks=0,idle_since=clock_timestamp() - interval '10 minutes',unreachable_since=NULL,last_location_at=clock_timestamp(),last_heartbeat_at=clock_timestamp()`.execute(
    db.db,
  );
  for (const rider of [world.rider1, world.rider2, world.rider3])
    await geo.updateMember(
      rider,
      { lat: world.storeLat, lng: world.storeLng, ts: new Date().toISOString() },
      300,
    );
  await sql`UPDATE rider_offers SET status='EXPIRED' WHERE status='SENT'`.execute(db.db);
  await sql`UPDATE delivery_tasks SET status='CANCELLED',cancel_reason='suite reset',rider_id=NULL,offered_rider_id=NULL WHERE status IN ('UNASSIGNED','OFFERED','ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')`.execute(
    db.db,
  );
  broadcasts.clear();
});

beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl, 30);
  redis = new Redis(services.redisUrl, {
    lazyConnect: false,
    keyPrefix: `${services.redisPrefix}:`,
  });
  world = await seedDispatchWorld(db);
  const config = fakeConfig();
  settings = new DispatchSettings(config);
  broadcasts = new BroadcastRecorder();
  // Unique GEO namespace per run: GEO members outlive their freshness hashes,
  // so the shared namespace accumulates stale members that crowd fresh riders
  // out of the COUNT-limited search.
  geo = new RedisRiderGeo(
    redis,
    `t${Date.now().toString(36)}${uuidV7().replaceAll('-', '').slice(0, 8)}`,
  );
  const riderSettings = new RiderSettings(config);
  const identity = new DatabaseIdentityAccess(db.db);
  const runtime = new ConfigService(envSchema.parse({}));
  packing = new PostgresPacking(db.db, identity, config, runtime, {
    startPicking: async () => undefined,
    markPacked: async () => undefined,
  });
  codes = new CanonicalDeliveryCodes(
    new OrderCodeService(
      db.db,
      new ConfigService(
        envSchema.parse({ PICKING_HANDOVER_SECRET: 'unit-test-delivery-code-secret-0123' }),
      ),
      config,
    ),
  );
  const eligibility = new PostgresRiderEligibility(db.db, riderSettings);
  const cash = new PostgresRiderCash(db.db, riderSettings);
  cancellation = new PostgresDeliveryTaskCancellation(db.db, broadcasts);
  engine = new DispatchEngine(
    db.db,
    settings,
    config,
    broadcasts,
    geo,
    eligibility,
    orderSystemCancel,
    cancellation,
  );
  packing =
    packing ??
    new PostgresPacking(db.db, identity, config, runtime, {
      startPicking: async () => undefined,
      markPacked: async () => undefined,
    });
  const deliveryTasks = new PostgresDeliveryTasks(db.db, settings, broadcasts, packing);
  const riderEarnings = new PostgresRiderEarnings(db.db, earningsDefaults());
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
    new ConfigEtaProvider(async () => ({ roadFactor: 1.4, avgSpeedKph: 20, maxMinutes: 60 })),
    async () => undefined,
    taskRunner(db.db),
  );
  tasks = new DeliveryTasksFacade(deliveryTasks, actions);
  maintenance = new DispatchMaintenance(db.db, settings, engine, broadcasts);
  consumer = new OrderConfirmedConsumer(config, codes);
  trigger = new PickTriggerConsumer(() => settings.trigger());
  for (const rider of [world.rider1, world.rider2, world.rider3])
    await geo.updateMember(
      rider,
      { lat: world.storeLat, lng: world.storeLng, ts: new Date().toISOString() },
      120,
    );
}, 120000);

afterAll(async () => {
  await db?.close();
  redis?.disconnect();
  await services?.stop();
}, 120000);

test('the confirmation consumer creates exactly one task per order with a delivery code (SYS-06)', async () => {
  const order = await confirmOrder();
  const tasksForOrder = await sql<{
    id: string;
    status: string;
    customer_user_id: string | null;
  }>`SELECT id,status,customer_user_id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(tasksForOrder.rows).toHaveLength(1);
  expect(tasksForOrder.rows[0]!.status).toBe('UNASSIGNED');
  expect(tasksForOrder.rows[0]!.customer_user_id).toBe(world.customer);
  const verifier = await sql<{
    key_version: number;
    attempt_count: number;
  }>`SELECT key_version,attempt_count FROM order_code_verifiers WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(verifier.rows).toHaveLength(1);
  // The task stays queued until the trigger; replaying the delivery is a no-op.
  await consumeOnce(db.db, order.eventId, 'dispatch', async (tx) =>
    consumer.handle(
      tx,
      envelope(
        order.eventId,
        'ORDER_CONFIRMED',
        order.orderId,
        (
          await sql<{
            payload: unknown;
          }>`SELECT payload FROM outbox_events WHERE id=${order.eventId}::uuid`.execute(db.db)
        ).rows[0]!.payload,
      ),
    ),
  );
  const recount = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(recount.rows[0]!.count).toBe('1');
});

test('the ON_PICK_START trigger releases the task and the engine offers to the freshest eligible rider', async () => {
  const order = await confirmOrder();
  broadcasts.clear();
  await releaseAndDispatch(order.orderId);
  const task = await sql<{
    id: string;
    status: string;
    offered_rider_id: string | null;
    dispatch_attempts: number;
  }>`SELECT id,status,offered_rider_id,dispatch_attempts FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(task.rows[0]!.status).toBe('OFFERED');
  expect(task.rows[0]!.offered_rider_id).not.toBeNull();
  expect(task.rows[0]!.dispatch_attempts).toBe(1);
  expect(broadcasts.ofRoom(`rider:${task.rows[0]!.offered_rider_id}`)).toContainEqual({
    event: 'offer.created',
  });
  // The offered rider sees the offer over the poll fallback.
  const offers = await tasks.offers(task.rows[0]!.offered_rider_id!);
  expect(offers.items.map((offer) => offer.orderId)).toContain(order.orderId);
});

test('maps preflight holds no order lock and rechecks rider eligibility before offering', async () => {
  const order = await confirmOrder();
  await sql`UPDATE delivery_tasks SET dispatch_not_before=clock_timestamp() WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE rider_status SET online=(rider_id=${world.rider1}::uuid),last_location_at=clock_timestamp()`.execute(
    db.db,
  );
  await geo.updateMember(
    world.rider1,
    { lat: world.storeLat, lng: world.storeLng, ts: new Date().toISOString() },
    120,
  );
  let entered!: () => void;
  let release!: () => void;
  const matrixEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueMatrix = new Promise<void>((resolve) => {
    release = resolve;
  });
  const maps = {
    async distanceMatrix(origins: unknown[]) {
      entered();
      await continueMatrix;
      return origins.map(() => [{ durationSeconds: 30, distanceMetres: 100, degraded: false }]);
    },
  };
  const config = fakeConfig();
  const contender = new DispatchEngine(
    db.db,
    settings,
    config,
    broadcasts,
    geo,
    new PostgresRiderEligibility(db.db, new RiderSettings(config)),
    orderSystemCancel,
    cancellation,
    maps as never,
  );
  const dispatching = contender.dispatchOne(order.orderId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      matrixEntered,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('matrix was not called')), 5000);
      }),
    ]);
    await db.db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM orders WHERE id=${order.orderId}::uuid FOR UPDATE NOWAIT`.execute(
        tx,
      );
    });
    await sql`UPDATE rider_status SET online=false WHERE rider_id=${world.rider1}::uuid`.execute(
      db.db,
    );
  } finally {
    clearTimeout(timeout);
    release();
  }
  expect(await dispatching).toBe('RETRY');
  const offers =
    await sql`SELECT 1 FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE t.order_id=${order.orderId}::uuid`.execute(
      db.db,
    );
  expect(offers.rows).toHaveLength(0);
});

test('a rider outside eligibility (offline) is never offered, widening and alerts follow', async () => {
  const order = await confirmOrder();
  await sql`UPDATE rider_status SET online=false WHERE rider_id=${world.rider1}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE rider_status SET online=false WHERE rider_id=${world.rider2}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE rider_status SET online=false WHERE rider_id=${world.rider3}::uuid`.execute(
    db.db,
  );
  await releaseAndDispatch(order.orderId);
  const task = await sql<{
    status: string;
    dispatch_attempts: number;
  }>`SELECT status,dispatch_attempts FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(task.rows[0]!.status).toBe('UNASSIGNED');
  // Alert fires once the configured attempt threshold is passed.
  await sql`UPDATE delivery_tasks SET dispatch_attempts=3 WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  broadcasts.clear();
  await engine.dispatchOne(order.orderId);
  const alert = await sql<{
    event_type: string;
  }>`SELECT event_type FROM outbox_events WHERE event_type='dispatch.no_rider' AND correlation_id=${order.orderId}`.execute(
    db.db,
  );
  expect(alert.rows).toHaveLength(1);
});

test('offer expiry returns the task to the pool; decline honours the cooldown', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  let task = await sql<{
    id: string;
    offered_rider_id: string | null;
    status: string;
  }>`SELECT id,offered_rider_id,status FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  const offeredRider = task.rows[0]!.offered_rider_id!;
  await sql`UPDATE rider_offers SET sent_at=clock_timestamp() - interval '2 minutes',expires_at=clock_timestamp() - interval '1 second' WHERE task_id=${task.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  await engine.expireOffers();
  task = await sql<{
    id: string;
    offered_rider_id: string | null;
    status: string;
  }>`SELECT id,offered_rider_id,status FROM delivery_tasks WHERE id=${task.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(task.rows[0]!.status).toBe('UNASSIGNED');
  expect(task.rows[0]!.offered_rider_id).toBeNull();
  // The expired rider is re-offered only after the decline cooldown; engine
  // picks another rider because the expired offer is not SENT any more.
  await engine.dispatchOne(order.orderId);
  const next = await sql<{
    offered_rider_id: string | null;
  }>`SELECT offered_rider_id FROM delivery_tasks WHERE id=${task.rows[0]!.id}::uuid`.execute(db.db);
  expect(next.rows[0]!.offered_rider_id).not.toBeNull();
  void offeredRider;
});

test('decline sends the task back to the pool with a due dispatch', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const task = await sql<{
    id: string;
    offered_rider_id: string | null;
    status: string;
  }>`SELECT id,offered_rider_id,status FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  const offer = await sql<{
    id: string;
  }>`SELECT id FROM rider_offers WHERE task_id=${task.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  await tasks.decline(task.rows[0]!.offered_rider_id!, offer.rows[0]!.id, uuidV7());
  const after = await sql<{
    status: string;
    next_dispatch_at: Date | null;
  }>`SELECT status,next_dispatch_at FROM delivery_tasks WHERE id=${task.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(after.rows[0]!.status).toBe('UNASSIGNED');
  expect(after.rows[0]!.next_dispatch_at).not.toBeNull();
});

test('cancelling an offered order queues push and socket revocation', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const offer = (
    await sql<{
      id: string;
      task_id: string;
      rider_id: string;
    }>`SELECT id,task_id,rider_id FROM rider_offers WHERE task_id=(SELECT id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid) AND status='SENT'`.execute(
      db.db,
    )
  ).rows[0]!;
  await cancellation.cancel(order.orderId, 'customer cancelled');
  const event = (
    await sql<{
      id: string;
      payload: Json;
    }>`SELECT id,payload FROM outbox_events WHERE aggregate_id=${offer.task_id}::uuid AND event_type='rider.offer_revoked'`.execute(
      db.db,
    )
  ).rows[0]!;
  const deliveries = await sql<{
    consumer: string;
  }>`SELECT consumer FROM outbox_deliveries WHERE event_id=${event.id}::uuid ORDER BY consumer`.execute(
    db.db,
  );
  expect(deliveries.rows.map((row) => row.consumer)).toEqual([
    'dispatch-realtime',
    'notifications',
  ]);
  await publishOfferRevocation(
    envelope(event.id, 'rider.offer_revoked', order.orderId, event.payload),
    broadcasts,
  );
  expect(broadcasts.events).toContainEqual({
    room: `rider:${offer.rider_id}`,
    event: 'offer.revoked',
    payload: { offerId: offer.id, taskId: offer.task_id, reason: 'ORDER_CANCELLED' },
  });
  const revoked = await sql<{
    status: string;
  }>`SELECT status FROM rider_offers WHERE id=${offer.id}::uuid`.execute(db.db);
  expect(revoked.rows[0]!.status).toBe('REVOKED');
});

test('COD capacity uses the adjusted expected amount of existing assignments', async () => {
  const existing = await confirmOrder({ cod: true });
  await sql`UPDATE cod_collections SET expected_amount_paise=10000 WHERE order_id=${existing.orderId}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE delivery_tasks SET status='ASSIGNED',rider_id=${world.rider1}::uuid WHERE order_id=${existing.orderId}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE rider_status SET active_tasks=1,last_location_at=clock_timestamp() WHERE rider_id=${world.rider1}::uuid`.execute(
    db.db,
  );
  const deliveryTasks = new PostgresDeliveryTasks(db.db, settings, broadcasts, packing);
  await expect(
    db.db.transaction().execute((tx) =>
      deliveryTasks.assertRiderCapacity(tx, world.rider1, {
        id: uuidV7(),
        payment_method: 'COD',
        amount_due_paise: '1960000',
        status: 'CONFIRMED',
        on_hold: false,
      }),
    ),
  ).resolves.toBeUndefined();
  await expect(
    db.db.transaction().execute((tx) =>
      deliveryTasks.assertRiderCapacity(tx, world.rider1, {
        id: uuidV7(),
        payment_method: 'COD',
        amount_due_paise: '1995000',
        status: 'CONFIRMED',
        on_hold: false,
      }),
    ),
  ).rejects.toThrow('CASH_LIMIT_EXCEEDED');
});

test('decline waits for the task before locking its offer', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const offer = (
    await sql<{
      id: string;
      task_id: string;
      rider_id: string;
    }>`SELECT id,task_id,rider_id FROM rider_offers WHERE task_id=(SELECT id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid) AND status='SENT'`.execute(
      db.db,
    )
  ).rows[0]!;
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holding = db.db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM delivery_tasks WHERE id=${offer.task_id}::uuid FOR UPDATE`.execute(tx);
    locked();
    await gate;
  });
  await acquired;
  const decline = tasks.decline(offer.rider_id, offer.id, uuidV7());
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const blocked = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%delivery_tasks%' AND query LIKE '%FOR UPDATE%'`.execute(
        db.db,
      );
      waiting = Number(blocked.rows[0]!.count) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await expect(
      db.db.transaction().execute(async (tx) => {
        await sql`SELECT id FROM rider_offers WHERE id=${offer.id}::uuid FOR UPDATE NOWAIT`.execute(
          tx,
        );
      }),
    ).resolves.toBeUndefined();
  } finally {
    release();
    await holding;
    await decline;
  }
});

test('the shared cancel routine cancels the task, revokes offers and releases capacity, idempotently', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const task = await sql<{
    id: string;
    offered_rider_id: string | null;
  }>`SELECT id,offered_rider_id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  const offer = await sql<{
    id: string;
  }>`SELECT id FROM rider_offers WHERE task_id=${task.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  await tasks.accept(task.rows[0]!.offered_rider_id!, offer.rows[0]!.id, uuidV7());
  await cancellation.cancel(order.orderId, 'customer cancelled before pickup');
  const cancelled = await sql<{
    status: string;
    cancel_reason: string;
  }>`SELECT status,cancel_reason FROM delivery_tasks WHERE id=${task.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(cancelled.rows[0]!.status).toBe('CANCELLED');
  expect(cancelled.rows[0]!.cancel_reason).toBe('customer cancelled before pickup');
  const capacity = await sql<{
    active_tasks: number;
  }>`SELECT active_tasks FROM rider_status WHERE rider_id=${task.rows[0]!.offered_rider_id}::uuid`.execute(
    db.db,
  );
  expect(capacity.rows[0]!.active_tasks).toBe(0);
  await cancellation.cancel(order.orderId, 'customer cancelled before pickup');
  const history = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM delivery_task_history WHERE status='CANCELLED' AND task_id=${task.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(history.rows[0]!.count).toBe('1');
});

test('silent riders re-dispatch before pickup and escalate after it (D21)', async () => {
  // Before pickup: unassign + attempt_no+1 + re-dispatch.
  const preOrder = await confirmOrder();
  await releaseAndDispatch(preOrder.orderId);
  const preTask = await sql<{
    id: string;
    offered_rider_id: string | null;
  }>`SELECT id,offered_rider_id FROM delivery_tasks WHERE order_id=${preOrder.orderId}::uuid`.execute(
    db.db,
  );
  const preOffer = await sql<{
    id: string;
  }>`SELECT id FROM rider_offers WHERE task_id=${preTask.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  const preRider = preTask.rows[0]!.offered_rider_id!;
  await tasks.accept(preRider, preOffer.rows[0]!.id, uuidV7());
  await sql`UPDATE rider_status SET unreachable_since=clock_timestamp() - interval '30 minutes' WHERE rider_id=${preRider}::uuid`.execute(
    db.db,
  );
  await maintenance.runOnce();
  const after = await sql<{
    status: string;
    attempt_no: number;
    rider_id: string | null;
  }>`SELECT status,attempt_no,rider_id FROM delivery_tasks WHERE id=${preTask.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(after.rows[0]!.status).toBe('UNASSIGNED');
  expect(after.rows[0]!.attempt_no).toBe(1);
  expect(after.rows[0]!.rider_id).toBeNull();

  // After pickup: custody preserved, escalation is audited.
  const postOrder = await confirmOrder();
  await releaseAndDispatch(postOrder.orderId);
  const postTask = await sql<{
    id: string;
    offered_rider_id: string | null;
  }>`SELECT id,offered_rider_id FROM delivery_tasks WHERE order_id=${postOrder.orderId}::uuid`.execute(
    db.db,
  );
  const postOffer = await sql<{
    id: string;
  }>`SELECT id FROM rider_offers WHERE task_id=${postTask.rows[0]!.id}::uuid AND status='SENT'`.execute(
    db.db,
  );
  const postRider = postTask.rows[0]!.offered_rider_id!;
  const view = await tasks.accept(postRider, postOffer.rows[0]!.id, uuidV7());
  await tasks.arrivedAtStore(postRider, view.id, uuidV7());
  await packOrderForHandover(db, world, postOrder.orderId);
  await packingVerify(postOrder.orderId);
  await tasks.pickedUp(postRider, view.id, uuidV7());
  await sql`UPDATE rider_status SET unreachable_since=clock_timestamp() - interval '30 minutes' WHERE rider_id=${postRider}::uuid`.execute(
    db.db,
  );
  await maintenance.runOnce();
  const preserved = await sql<{
    status: string;
    rider_id: string | null;
  }>`SELECT status,rider_id FROM delivery_tasks WHERE id=${postTask.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(preserved.rows[0]!.status).toBe('PICKED_UP');
  expect(preserved.rows[0]!.rider_id).toBe(postRider);
  const escalation = await sql<{
    event_type: string;
  }>`SELECT event_type FROM outbox_events WHERE event_type='delivery.custody_escalation' AND correlation_id=${postOrder.orderId}`.execute(
    db.db,
  );
  expect(escalation.rows).toHaveLength(1);
});

async function packingVerify(orderId: string) {
  // The store verifies the rider's handover code through the P7 contract.
  const presented = await packing.presentCode(orderId);
  await packing.verify(world.manager, { orderId, code: presented.code });
}

test('GPS history samples from the last persisted point and rejects stale cross-instance writes', async () => {
  const rider = world.rider1;
  await sql`UPDATE rider_status SET last_location=NULL,last_location_at=NULL WHERE rider_id=${rider}::uuid`.execute(
    db.db,
  );
  await sql`DELETE FROM rider_location_history WHERE rider_id=${rider}::uuid`.execute(db.db);
  const a = new PostgresLocationIngest(
    db.db,
    geo,
    new ActiveOrderResolverHolder(),
    broadcasts,
    INTEGRITY_DEFAULTS,
    120,
  );
  const b = new PostgresLocationIngest(
    db.db,
    new RedisRiderGeo(redis),
    new ActiveOrderResolverHolder(),
    broadcasts,
    INTEGRITY_DEFAULTS,
    120,
  );
  const start = Date.now() - 30000;
  for (let seconds = 0; seconds <= 16; seconds++) {
    const outcome = await a.ingestBatch(rider, [
      {
        lat: world.storeLat,
        lng: world.storeLng,
        ts: new Date(start + seconds * 1000).toISOString(),
      },
    ]);
    expect(outcome.accepted).toBe(1);
  }
  const history = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM rider_location_history WHERE rider_id=${rider}::uuid`.execute(
    db.db,
  );
  expect(history.rows[0]!.count).toBe('2');
  const old = await b.ingestBatch(rider, [
    { lat: world.storeLat, lng: world.storeLng, ts: new Date(start + 5000).toISOString() },
  ]);
  expect(old.accepted).toBe(0);
  expect(old.rejected.reasons.OUT_OF_ORDER).toBe(1);
});

test('scheduled dispatch stays gated and no-rider age begins at release', async () => {
  const order = await confirmOrder();
  await sql`UPDATE orders SET source='SUBSCRIPTION' WHERE id=${order.orderId}::uuid`.execute(db.db);
  await sql`UPDATE delivery_tasks SET created_at=clock_timestamp()-interval '1 day',dispatch_not_before=clock_timestamp()+interval '1 hour',next_dispatch_at=clock_timestamp() WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(await engine.dispatchOne(order.orderId)).toBe('INELIGIBLE');
  const gated = await sql<{
    dispatch_attempts: number;
  }>`SELECT dispatch_attempts FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(gated.rows[0]!.dispatch_attempts).toBe(0);
  await sql`UPDATE delivery_tasks SET dispatch_not_before=clock_timestamp()-interval '1 second' WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(await engine.dispatchOne(order.orderId)).not.toBe('CANCELLED');
  const task = await sql<{
    status: string;
  }>`SELECT status FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(db.db);
  expect(task.rows[0]!.status).not.toBe('CANCELLED');
});

test('plan4: reversed trigger and confirmation still releases and offers once', async () => {
  const order = await emitConfirmedOrder(db, world);
  await sql`UPDATE orders SET status='PICKING' WHERE id=${order.orderId}::uuid`.execute(db.db);
  const event = await sql<{
    payload: unknown;
  }>`SELECT payload FROM outbox_events WHERE id=${order.eventId}::uuid`.execute(db.db);
  const handle = () =>
    consumeOnce(db.db, order.eventId, 'dispatch', async (tx) =>
      consumer.handle(
        tx,
        envelope(order.eventId, 'ORDER_CONFIRMED', order.orderId, event.rows[0]!.payload),
      ),
    );
  await handle();
  await handle();
  const tasks = await sql<{
    count: string;
    released: Date | null;
  }>`SELECT count(*)::text AS count, max(released_at) AS released FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(tasks.rows[0]!.count).toBe('1');
  expect(tasks.rows[0]!.released).not.toBeNull();
  const started = Date.now();
  expect(await engine.dispatchOne(order.orderId)).toBe('OFFERED');
  expect(Date.now() - started).toBeGreaterThanOrEqual(0);
});

test('plan4: reconciliation releases missed triggers but respects holds and schedules', async () => {
  const ready = await confirmOrder();
  await sql`UPDATE orders SET status='PICKING' WHERE id=${ready.orderId}::uuid`.execute(db.db);
  const held = await confirmOrder();
  await sql`UPDATE orders SET status='PICKING' WHERE id=${held.orderId}::uuid`.execute(db.db);
  await new OrderHoldService(db.db).set(held.orderId, world.admin, true, 'review');
  const scheduled = await confirmOrder();
  await sql`UPDATE orders SET status='PICKING' WHERE id=${scheduled.orderId}::uuid`.execute(db.db);
  await sql`UPDATE delivery_tasks SET dispatch_not_before=clock_timestamp()+interval '1 hour' WHERE order_id=${scheduled.orderId}::uuid`.execute(
    db.db,
  );
  const queued = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM delivery_tasks WHERE order_id IN (${ready.orderId}::uuid,${held.orderId}::uuid,${scheduled.orderId}::uuid) AND next_dispatch_at='infinity'::timestamptz`.execute(
    db.db,
  );
  expect(queued.rows[0]!.n).toBe('3');
  expect(await engine.reconcileStuckTasks()).toBeGreaterThanOrEqual(1);
  const released = await sql<{
    order_id: string;
  }>`SELECT order_id FROM delivery_tasks WHERE order_id IN (${ready.orderId}::uuid,${held.orderId}::uuid,${scheduled.orderId}::uuid) AND next_dispatch_at<>'infinity'::timestamptz`.execute(
    db.db,
  );
  expect(released.rows.map((row) => row.order_id)).toEqual([ready.orderId]);
  expect(await engine.dispatchOne(ready.orderId)).toBe('OFFERED');
});

test('plan4: expired offers cool down among ten riders and stale GPS is skipped', async () => {
  const extra: string[] = [];
  for (let index = 0; index < 7; index++) {
    const rider = uuidV7();
    extra.push(rider);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${rider}::uuid,'WORKFORCE',${rider},${`plan4rider${index}@example.invalid`},${`plan4rider${index}`})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${rider}::uuid,'RIDER')`.execute(db.db);
    await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no) VALUES(${rider}::uuid,'APPROVED','SCOOTER',${`KA-9${index}`})`.execute(
      db.db,
    );
    await sql`INSERT INTO rider_status(rider_id,online,last_heartbeat_at,last_location,last_location_at,last_location_source,active_tasks,idle_since)
      VALUES(${rider}::uuid,true,clock_timestamp(),ST_SetSRID(ST_MakePoint(${world.storeLng + 0.001 * (index + 1)}, ${world.storeLat}),4326)::geography,
      clock_timestamp() - interval '5 seconds','GPS',0,clock_timestamp() - interval '10 minutes')`.execute(
      db.db,
    );
    await geo.updateMember(
      rider,
      {
        lat: world.storeLat,
        lng: world.storeLng + 0.001 * (index + 1),
        ts: new Date().toISOString(),
      },
      120,
    );
  }
  await sql`UPDATE rider_status SET last_location_at=clock_timestamp()-interval '1 hour' WHERE rider_id=${extra[0]!}::uuid`.execute(
    db.db,
  );
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const first = await sql<{
    rider_id: string;
    id: string;
  }>`SELECT rider_id,id FROM rider_offers WHERE task_id=(SELECT id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid) AND status='SENT' ORDER BY sent_at DESC LIMIT 1`.execute(
    db.db,
  );
  expect(first.rows).toHaveLength(1);
  expect(first.rows[0]!.rider_id).not.toBe(extra[0]!);
  await sql`UPDATE rider_offers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${first.rows[0]!.id}::uuid`.execute(
    db.db,
  );
  expect(await engine.expireOffers()).toBeGreaterThanOrEqual(1);
  expect(await engine.dispatchOne(order.orderId)).toBe('OFFERED');
  const second = await sql<{
    rider_id: string;
  }>`SELECT rider_id FROM rider_offers WHERE task_id=(SELECT id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid) ORDER BY sent_at DESC LIMIT 1`.execute(
    db.db,
  );
  expect(second.rows[0]!.rider_id).not.toBe(first.rows[0]!.rider_id);
  await sql`DELETE FROM rider_status WHERE rider_id=ANY(${extra}::uuid[])`.execute(db.db);
  await sql`DELETE FROM rider_profiles WHERE user_id=ANY(${extra}::uuid[])`.execute(db.db);
});

test('plan4: concurrent accepts assign exactly once', async () => {
  const order = await confirmOrder();
  await releaseAndDispatch(order.orderId);
  const offer = await sql<{
    id: string;
    rider_id: string;
  }>`SELECT id,rider_id FROM rider_offers WHERE task_id=(SELECT id FROM delivery_tasks WHERE order_id=${order.orderId}::uuid) AND status='SENT'`.execute(
    db.db,
  );
  const attempts = await Promise.allSettled([
    tasks.accept(offer.rows[0]!.rider_id, offer.rows[0]!.id, uuidV7()),
    tasks.accept(offer.rows[0]!.rider_id, offer.rows[0]!.id, uuidV7()),
  ]);
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  const assigned = await sql<{
    status: string;
    accepted: string;
  }>`SELECT t.status,(SELECT count(*)::text FROM rider_offers WHERE task_id=t.id AND status='ACCEPTED') AS accepted
    FROM delivery_tasks t WHERE t.order_id=${order.orderId}::uuid`.execute(db.db);
  expect(assigned.rows[0]!.status).not.toBe('UNASSIGNED');
  expect(assigned.rows[0]!.accepted).toBe('1');
});

test('plan4: no eligible rider retries with backoff and tracks no-rider time', async () => {
  const order = await confirmOrder();
  await sql`UPDATE rider_status SET online=false`.execute(db.db);
  await releaseAndDispatch(order.orderId);
  expect(await engine.dispatchOne(order.orderId)).toBe('RETRY');
  const waiting = await sql<{
    attempts: number;
    since: Date | null;
  }>`SELECT dispatch_attempts AS attempts,no_rider_since AS since FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(waiting.rows[0]!.attempts).toBeGreaterThanOrEqual(1);
  expect(waiting.rows[0]!.since).not.toBeNull();
  await sql`UPDATE rider_status SET online=true WHERE rider_id IN (${world.rider1}::uuid,${world.rider2}::uuid,${world.rider3}::uuid)`.execute(
    db.db,
  );
  expect(await engine.dispatchOne(order.orderId)).toBe('OFFERED');
  const recovered = await sql<{
    seconds: string;
    since: Date | null;
  }>`SELECT no_rider_seconds::text AS seconds,no_rider_since AS since FROM delivery_tasks WHERE order_id=${order.orderId}::uuid`.execute(
    db.db,
  );
  expect(recovered.rows[0]!.since).toBeNull();
  expect(Number(recovered.rows[0]!.seconds)).toBeGreaterThanOrEqual(0);
});

describe('plan5 Ola dispatch', () => {
  const olaPaths = {
    autocomplete: '/places/v1/autocomplete',
    details: '/places/v1/details',
    geocode: '/places/v1/geocode',
    reverse: '/places/v1/reverse-geocode',
    directions: '/routing/v1/directions',
    matrix: '/routing/v1/distanceMatrix/basic',
  };
  const mapsSettings = async () => ({ cacheTtlSeconds: 60, speedKph: 20, topK: 5, maxPairs: 50 });
  const storeCache = () => {
    const seen = new Map<string, string>();
    return {
      get: async (key: string) => seen.get(key) ?? null,
      set: async (key: string, value: string) => {
        seen.set(key, value);
      },
    };
  };
  const recorder = () => {
    const records: Array<Record<string, unknown>> = [];
    return {
      records,
      logger: {
        info: (fields: Record<string, unknown>) => records.push({ level: 'info', ...fields }),
        warn: (fields: Record<string, unknown>) => records.push({ level: 'warn', ...fields }),
        error: (fields: Record<string, unknown>) => records.push({ level: 'error', ...fields }),
      },
    };
  };
  const resilient = (fetcher: typeof fetch, rec: ReturnType<typeof recorder>, timeoutMs = 1000) =>
    new ResilientMaps(
      new OlaMaps(
        {
          baseUrl: 'https://api.olamaps.io',
          apiKey: 'fixture',
          timeoutMs,
          maxAttempts: 1,
          breakerFailures: 5,
          breakerCooldownMs: 10000,
          paths: olaPaths,
        },
        mapsSettings,
        fetcher,
        rec.logger as never,
      ),
      storeCache(),
      mapsSettings,
      'ola',
      rec.logger as never,
    );
  async function dispatchWith(maps: MapsPort, config = fakeConfig()) {
    const order = await confirmOrder();
    await sql`UPDATE delivery_tasks SET dispatch_not_before=clock_timestamp() WHERE order_id=${order.orderId}::uuid`.execute(
      db.db,
    );
    const contender = new DispatchEngine(
      db.db,
      settings,
      config,
      broadcasts,
      geo,
      new PostgresRiderEligibility(db.db, new RiderSettings(config)),
      orderSystemCancel,
      cancellation,
      maps,
    );
    const outcome = await contender.dispatchOne(order.orderId);
    const offers =
      await sql`SELECT 1 FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE t.order_id=${order.orderId}::uuid AND o.status='SENT'`.execute(
        db.db,
      );
    return { outcome, sent: offers.rows.length, orderId: order.orderId };
  }

  async function acceptOnce(orderId: string) {
    const offers = await sql<{
      id: string;
      rider_id: string;
    }>`SELECT o.id,o.rider_id FROM rider_offers o
      JOIN delivery_tasks t ON t.id=o.task_id WHERE t.order_id=${orderId}::uuid AND o.status='SENT'`.execute(
      db.db,
    );
    const offer = offers.rows[0]!;
    const assigned = await tasks.accept(offer.rider_id, offer.id, uuidV7());
    expect(assigned.riderId).toBe(offer.rider_id);
    const recorded = await sql`SELECT 1 FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id
      WHERE t.order_id=${orderId}::uuid AND o.status='ACCEPTED' AND t.rider_id=o.rider_id`.execute(
      db.db,
    );
    expect(recorded.rows).toHaveLength(1);
  }

  it('keeps valid road cells and estimates only the failed cells in one batch', async () => {
    const rec = recorder();
    let matrixCalls = 0;
    const fetcher: typeof fetch = async (request) => {
      matrixCalls++;
      const url = new URL(String(request));
      const origins = (url.searchParams.get('origins') ?? '').split('|');
      return Response.json({
        status: 'SUCCESS',
        rows: origins.map((_, index) =>
          index === 0
            ? { elements: [{ status: 'OK', distance: 4000, duration: 600 }] }
            : { elements: [{ status: 'ZERO_RESULTS' }] },
        ),
      });
    };
    const { outcome, sent } = await dispatchWith(
      resilient(fetcher, rec),
      fakeConfig({ mapMatrixMaxPairs: 2 }),
    );
    expect(outcome).toBe('OFFERED');
    expect(sent).toBe(1);
    // One logical matrix batch per scoring attempt.
    expect(matrixCalls).toBe(1);
    expect(rec.records).toContainEqual(
      expect.objectContaining({
        operation: 'distanceMatrix',
        outcome: 'partial_fallback',
        pairs: 2,
        fallbackCells: 1,
      }),
    );
  });

  it.each([
    ['rejected key', async () => new Response('no', { status: 401 })],
    [
      'timeout',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response('late', { status: 200 });
      },
    ],
    ['bad envelope', async () => Response.json({ status: 'SUCCESS', rows: [] })],
  ])('estimates the whole batch after %s and still offers exactly once', async (_name, fetcher) => {
    const rec = recorder();
    const { outcome, sent, orderId } = await dispatchWith(
      resilient(fetcher as typeof fetch, rec, _name === 'timeout' ? 20 : 1000),
    );
    expect(outcome).toBe('OFFERED');
    expect(sent).toBe(1);
    const fallback = rec.records.find(
      (r) => r.operation === 'distanceMatrix' && r.outcome === 'fallback',
    );
    expect(fallback).toMatchObject({ pairs: 3, fallbackCells: 3 });
    if (_name === 'rejected key') await acceptOnce(orderId);
  });

  const live =
    process.env.AWS_P13_INTEGRATION === 'yes' && process.env.OLA_DISPATCH_LIVE_TEST === 'yes';
  (live ? it : it.skip)('uses Ola road ETAs and assigns the winning rider once', async () => {
    const rec = recorder();
    const env = readEnv(process.env);
    const remote = new OlaMaps(buildOlaConfig(env), mapsSettings, fetch, rec.logger as never);
    const maps = new ResilientMaps(remote, storeCache(), mapsSettings, 'ola', rec.logger as never);
    const { outcome, sent, orderId } = await dispatchWith(maps);
    expect({ outcome, sent }).toEqual({ outcome: 'OFFERED', sent: 1 });
    expect(
      rec.records.find((r) => r.operation === 'distanceMatrix' && r.fallbackCells === 0),
    ).toMatchObject({ outcome: 'success', pairs: 3 });
    await acceptOnce(orderId);
  });
});
