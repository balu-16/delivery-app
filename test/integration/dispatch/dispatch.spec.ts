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
import { envSchema } from '../../../src/config/env.schema.js';
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

test('holds prevent dispatch, offer acceptance and manual assignment until resumed', async () => {
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${world.manager}::uuid,'ADMIN') ON CONFLICT DO NOTHING`.execute(
    db.db,
  );
  const order = await confirmOrder();
  const holds = new OrderHoldService(db.db);
  await holds.set(order.orderId, world.manager, true, 'review');
  await releaseAndDispatch(order.orderId);
  expect(await engine.dispatchOne(order.orderId)).toBe('INELIGIBLE');
  const manual = new ManualAssignment(
    new PostgresDeliveryTasks(db.db, settings, broadcasts, packing),
  );
  await expect(
    manual.assign(order.orderId, world.rider1, world.manager, 'manual', uuidV7()),
  ).rejects.toThrow('ORDER_ON_HOLD');
  await holds.set(order.orderId, world.manager, false, 'cleared');
  expect(await engine.dispatchOne(order.orderId)).toBe('OFFERED');
  const offers = await sql<{
    id: string;
    rider_id: string;
  }>`SELECT o.id,o.rider_id FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE t.order_id=${order.orderId}::uuid AND o.status='SENT'`.execute(
    db.db,
  );
  const offer = offers.rows[0]!;
  await holds.set(order.orderId, world.manager, true, 'review again');
  await expect(tasks.accept(offer.rider_id, offer.id, uuidV7())).rejects.toThrow('ORDER_ON_HOLD');
  await holds.set(order.orderId, world.manager, false, 'cleared again');
  const accepted = await tasks.accept(offer.rider_id, offer.id, uuidV7());
  expect(accepted.riderId).toBe(offer.rider_id);
  await tasks.arrivedAtStore(offer.rider_id, accepted.id, uuidV7());
  await sql`INSERT INTO pick_tasks(id,order_id,store_id,status,sla_due_at,completed_at,completed_by)
    VALUES(${uuidV7()}::uuid,${order.orderId}::uuid,${world.store}::uuid,'COMPLETED',clock_timestamp(),clock_timestamp(),${world.manager}::uuid)`.execute(
    db.db,
  );
  await holds.set(order.orderId, world.manager, true, 'packing review');
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
  await holds.set(order.orderId, world.manager, false, 'packing cleared');
  await packing.pack(
    world.manager,
    order.orderId,
    { bags: '1', sealCode: 'seal', coldChain: false },
    uuidV7(),
  );
  await packing.verify(world.manager, { orderId: order.orderId, code: code.code });
  await holds.set(order.orderId, world.manager, true, 'pickup review');
  await expect(tasks.pickedUp(offer.rider_id, accepted.id, uuidV7())).rejects.toThrow(
    'ORDER_ON_HOLD',
  );
  await holds.set(order.orderId, world.manager, false, 'pickup cleared');
  await tasks.pickedUp(offer.rider_id, accepted.id, uuidV7());
  await expect(holds.set(order.orderId, world.manager, true, 'too late')).rejects.toThrow(
    'ILLEGAL_STATE_TRANSITION',
  );
});

/** Per-test isolation: the suite shares one world, so operational state resets. */
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
  geo = new RedisRiderGeo(redis);
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
  trigger = new PickTriggerConsumer(
    () => settings.trigger(),
    async () => undefined,
  );
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
