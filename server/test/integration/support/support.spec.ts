import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import type { PrivateUploadPort } from '../../../src/modules/identity/contracts/uploads.js';
import { PostgresSupport } from '../../../src/modules/support/infrastructure/postgres-support.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { seedDispatchWorld, emitConfirmedOrder } from '../../helpers/dispatch-fixture.js';
let services: TestServices;
let db: DatabaseHandle;
let world: Awaited<ReturnType<typeof seedDispatchWorld>>;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 4);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('enforces order and ticket ownership and excludes internal messages from customers', async () => {
  const w = (world = await seedDispatchWorld(db)),
    order = await emitConfirmedOrder(db, w),
    agent = uuidV7();
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${w.customer}::uuid,'CUSTOMER')`.execute(
    db.db,
  );
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${agent}::uuid,'WORKFORCE',${agent},${`${agent}@test.invalid`},'agent')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${agent}::uuid,'SUPPORT_AGENT')`.execute(
    db.db,
  );
  const cfg = {
    get: async (key: string) =>
      ({
        supportMessageMaxLength: 2000,
        supportTicketCreationLimitPerHour: 10,
        supportFirstResponseSlaHours: 4,
        supportResolutionSlaHours: 24,
        supportReopenDays: 7,
      })[key],
  } as unknown as AppConfig;
  const service = new PostgresSupport(db.db, cfg, {} as PrivateUploadPort);
  await expect(
    service.create(w.rider1, { category: 'delivery', orderId: order.orderId, body: 'hi' }),
  ).rejects.toThrow('RESOURCE_NOT_FOUND');
  const id = await service.create(w.customer, {
    category: 'delivery',
    orderId: order.orderId,
    body: '<broken>',
  });
  await service.message(agent, id, { body: 'private staff note', internal: true });
  await service.message(agent, id, { body: 'public reply' });
  await expect(service.detail(w.rider1, id, false)).rejects.toThrow('RESOURCE_NOT_FOUND');
  const customer = await service.detail(w.customer, id, false);
  expect(JSON.stringify(customer)).not.toContain('private staff note');
  expect(JSON.stringify(customer)).toContain('&lt;broken&gt;');
  expect(JSON.stringify(customer)).toContain('public reply');
  expect(JSON.stringify(await service.detail(agent, id, true))).toContain('private staff note');
  const first = (await service.detail(w.customer, id, false, undefined, 1)) as {
    messages: Array<{ id: string; body: string }>;
    nextMessagesCursor: string | null;
  };
  expect(first.messages).toHaveLength(1);
  expect(first.nextMessagesCursor).toBeTruthy();
  const second = (await service.detail(w.customer, id, false, first.nextMessagesCursor!, 1)) as {
    messages: Array<{ id: string; body: string }>;
    nextMessagesCursor: string | null;
  };
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]!.body).toBe('public reply');
  expect(second.nextMessagesCursor).toBeNull();
  const staffFirst = (await service.detail(agent, id, true, undefined, 1)) as {
    messages: unknown[];
    nextMessagesCursor: string | null;
  };
  const staffSecond = (await service.detail(
    agent,
    id,
    true,
    staffFirst.nextMessagesCursor!,
    1,
  )) as { messages: unknown[]; nextMessagesCursor: string | null };
  expect(JSON.stringify(staffSecond.messages)).toContain('private staff note');
  const cannedAdmin = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${cannedAdmin}::uuid,'WORKFORCE',${cannedAdmin},${`${cannedAdmin}@test.invalid`},'admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${cannedAdmin}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await service.saveCanned(cannedAdmin, { label: 'First', body: 'one', active: true });
  await service.saveCanned(cannedAdmin, { label: 'Second', body: 'two', active: true });
  const cannedFirst = await service.canned(agent, undefined, 1),
    cannedSecond = await service.canned(agent, cannedFirst.nextCursor!, 1);
  expect(cannedFirst.items).toHaveLength(1);
  expect(cannedSecond.items).toHaveLength(1);
  expect(cannedSecond.nextCursor).toBeNull();

  await expect(service.message(w.customer, id, { body: 'spoof', internal: true })).rejects.toThrow(
    'FORBIDDEN',
  );
  await service.update(agent, id, { status: 'RESOLVED' });
  await service.update(w.customer, id, { status: 'OPEN' });
  const cycle = await sql<{
    sla_cycle: number;
    first_response_at: Date | null;
  }>`SELECT sla_cycle,first_response_at FROM support_tickets WHERE id=${id}::uuid`.execute(db.db);
  expect(cycle.rows[0]).toEqual({ sla_cycle: 2, first_response_at: null });
  await service.update(agent, id, { status: 'RESOLVED' });
  await sql`UPDATE support_tickets SET resolved_at=clock_timestamp()-interval '8 days' WHERE id=${id}::uuid`.execute(
    db.db,
  );
  await expect(service.update(w.customer, id, { status: 'OPEN' })).rejects.toThrow(
    'REOPEN_WINDOW_EXPIRED',
  );
});

it('recovers failed-delivery tickets and sends each SLA breach once', async () => {
  const w = world;
  const order = await emitConfirmedOrder(db, w);
  const task = uuidV7();
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,status,failure_reason,rider_id) VALUES(${task}::uuid,${order.orderId}::uuid,${w.store}::uuid,'FAILED','unreachable',${w.rider1}::uuid)`.execute(
    db.db,
  );
  const config = {
    get: async (key: string) =>
      ({ supportFirstResponseSlaHours: 4, supportResolutionSlaHours: 24 })[key],
  } as unknown as AppConfig;
  const { P11Worker } = await import('../../../src/modules/support/infrastructure/p11-worker.js');
  const worker = new P11Worker(db, {} as never, config, {} as never);
  await worker.incidents();
  await worker.incidents();
  const tickets = await sql<{
    id: string;
  }>`SELECT id FROM support_tickets WHERE incident_key=${`delivery:${task}`}`.execute(db.db);
  expect(tickets.rows).toHaveLength(1);
  const id = tickets.rows[0]!.id;
  await sql`UPDATE support_tickets SET first_response_due_at=clock_timestamp()-interval '1 hour',resolution_due_at=clock_timestamp()-interval '1 hour' WHERE id=${id}::uuid`.execute(
    db.db,
  );
  await worker.alerts();
  await worker.alerts();
  await worker.alerts();
  const alerts = await sql<{
    kind: string;
  }>`SELECT kind FROM support_sla_alerts WHERE ticket_id=${id}::uuid ORDER BY kind`.execute(db.db);
  expect(alerts.rows.map((row) => row.kind)).toEqual(['FIRST_RESPONSE', 'RESOLUTION']);
  const events = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM outbox_events WHERE aggregate_id=${id}::uuid AND event_type='ops.anomaly'`.execute(
    db.db,
  );
  expect(events.rows[0]?.n).toBe('2');
});

it('enforces configured support direct-refund caps and replays a direct operation once', async () => {
  const w = world,
    order = await emitConfirmedOrder(db, w),
    agent = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${agent}::uuid,'WORKFORCE',${agent},${`${agent}@test.invalid`},'agent')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${agent}::uuid,'SUPPORT_AGENT')`.execute(
    db.db,
  );
  const { OrderAdministrationService } =
    await import('../../../src/modules/orders/infrastructure/administration.js');
  const { MakerChecker } =
    await import('../../../src/modules/compliance/infrastructure/maker-checker.js');
  const cfg = {
    get: async (key: string) =>
      ({ supportDirectRefundLimitPaise: '100', supportDailyRefundLimitPaise: '150' })[key],
  } as unknown as AppConfig;
  const { ORDERS } = await import('../../../src/modules/orders/contracts/orders.js');
  void ORDERS;
  let calls = 0;
  const fakeOrders = { byId: async () => ({ orderId: order.orderId }) };
  const fakeRefunds = {
    refundableCapacity: async () => [
      { sourceType: 'COD_COLLECTION', sourceId: 'collected', availablePaise: '1000' },
    ],
    commit: async () => {
      calls++;
    },
  };
  const service = new OrderAdministrationService(
    { create: (actions) => new MakerChecker(db.db, actions) },
    fakeOrders as never,
    fakeRefunds as never,
    db.db,
    cfg,
  );
  const input = { amountPaise: '100', reason: 'goodwill' };
  const direct = await service.requestSupportRefund(agent, order.orderId, input, 'same');
  expect(direct.startsWith('direct:')).toBe(true);
  expect(await service.requestSupportRefund(agent, order.orderId, input, 'same')).toBe(direct);
  expect(calls).toBe(1);
  await expect(
    service.requestSupportRefund(agent, order.orderId, { ...input, amountPaise: '50' }, 'same'),
  ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  const approval = await service.requestSupportRefund(
    agent,
    order.orderId,
    { ...input, amountPaise: '60' },
    'next',
  );
  expect(approval.startsWith('direct:')).toBe(false);
  const retries = await Promise.all(
    Array.from({ length: 5 }, () =>
      service.requestSupportRefund(agent, order.orderId, { ...input, amountPaise: '60' }, 'next'),
    ),
  );
  expect(retries.every((id) => id === approval)).toBe(true);
  await expect(
    service.requestSupportRefund(agent, order.orderId, { ...input, amountPaise: '70' }, 'next'),
  ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  expect(calls).toBe(1);
});
