import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresDeliveryTasks } from '../../../src/modules/dispatch/infrastructure/postgres-delivery-tasks.js';
import { DispatchSettings } from '../../../src/modules/dispatch/infrastructure/settings.js';
import type { HandoverCodes } from '../../../src/modules/picking/contracts/packing.js';
import {
  BroadcastRecorder,
  emitConfirmedOrder,
  fakeConfig,
  seedDispatchWorld,
} from '../../helpers/dispatch-fixture.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: DatabaseHandle;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 8);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

it('serializes two riders accepting offers for one task with a single assignment and one capacity charge', async () => {
  const world = await seedDispatchWorld(db);
  const order = await emitConfirmedOrder(db, world);
  const task = uuidV7(),
    firstOffer = uuidV7(),
    secondOffer = uuidV7();
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,offered_rider_id) VALUES(${task}::uuid,${order.orderId}::uuid,${world.store}::uuid,${world.customer}::uuid,'OFFERED',${world.rider1}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_offers(id,task_id,rider_id,attempt_no,status,expires_at) VALUES(${firstOffer}::uuid,${task}::uuid,${world.rider1}::uuid,0,'SENT',clock_timestamp()+interval '1 minute'),(${secondOffer}::uuid,${task}::uuid,${world.rider2}::uuid,0,'SENT',clock_timestamp()+interval '1 minute')`.execute(
    db.db,
  );
  const codes = {
    issue: async () => ({ state: 'PENDING' }),
    presentCode: async () => ({ code: '0000', keyVersion: 1 }),
  } as unknown as HandoverCodes;
  const tasks = new PostgresDeliveryTasks(
    db.db,
    new DispatchSettings(fakeConfig()),
    new BroadcastRecorder(),
    codes,
  );
  const expiredOrder = await emitConfirmedOrder(db, world);
  const expiredTask = uuidV7(),
    expiredOffer = uuidV7();
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,offered_rider_id) VALUES(${expiredTask}::uuid,${expiredOrder.orderId}::uuid,${world.store}::uuid,${world.customer}::uuid,'OFFERED',${world.rider3}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_offers(id,task_id,rider_id,attempt_no,status,sent_at,expires_at) VALUES(${expiredOffer}::uuid,${expiredTask}::uuid,${world.rider3}::uuid,0,'SENT',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 second')`.execute(
    db.db,
  );
  await expect(tasks.accept(world.rider3, expiredOffer, uuidV7())).rejects.toThrow('OFFER_EXPIRED');
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = db.db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM orders WHERE id=${order.orderId}::uuid FOR UPDATE`.execute(tx);
    ready();
    await gate;
  });
  await locked;
  const attempts = Promise.allSettled([
    tasks.accept(world.rider1, firstOffer, uuidV7()),
    tasks.accept(world.rider2, secondOffer, uuidV7()),
  ]);
  try {
    const deadline = Date.now() + 5000;
    let waiters = 0;
    while (Date.now() < deadline && waiters < 2) {
      const waiting = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%orders%'`.execute(
        db.db,
      );
      waiters = Number(waiting.rows[0]?.count ?? 0);
      if (waiters < 2) await delay(20);
    }
    expect(waiters).toBeGreaterThanOrEqual(2);
  } finally {
    release();
    await blocker;
  }
  const results = await attempts;
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const state = await sql<{
    status: string;
    rider_id: string;
    accepted: string;
    assigned: string;
    active: string;
  }>`SELECT t.status,t.rider_id,(SELECT count(*)::text FROM rider_offers WHERE task_id=t.id AND status='ACCEPTED') AS accepted,(SELECT count(*)::text FROM task_assignment_history WHERE task_id=t.id AND action='ASSIGNED') AS assigned,(SELECT sum(active_tasks)::text FROM rider_status WHERE rider_id IN (${world.rider1}::uuid,${world.rider2}::uuid)) AS active FROM delivery_tasks t WHERE t.id=${task}::uuid`.execute(
    db.db,
  );
  expect(state.rows[0]).toEqual({
    status: 'ASSIGNED',
    rider_id: world.rider1,
    accepted: '1',
    assigned: '1',
    active: '1',
  });
});
