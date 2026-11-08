import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { ConfigService as TestAppConfig } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { ConcernQueues } from '../../../src/platform/queue/concern-queues.js';
import { PostgresNotificationPipeline } from '../../../src/modules/notifications/infrastructure/postgres-pipeline.js';
import { PostgresNotificationViews } from '../../../src/modules/notifications/infrastructure/postgres-views.js';
import { DlqGrowthAlert } from '../../../src/modules/notifications/infrastructure/dlq-alert.js';
import { FakeEmail } from '../../../src/adapters/email/fake-email.js';
import { FakePush } from '../../../src/adapters/push/fake-push.js';
import {
  consumeEvent,
  emitNotificationEvent,
  seedInboxRow,
  seedNotificationsWorld,
  type NotificationsWorld,
} from '../../helpers/notifications-fixture.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices,
  db: DatabaseHandle,
  world: NotificationsWorld,
  push: FakePush,
  email: FakeEmail,
  pipeline: PostgresNotificationPipeline,
  views: PostgresNotificationViews;

const uuid = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const delay = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

async function deliveryRow(notificationId: string) {
  const rows = await sql<{
    id: string;
    status: string;
    attempts: number;
    last_error: string | null;
  }>`SELECT id,status,attempts,last_error FROM notification_deliveries WHERE notification_id=${notificationId}::uuid`.execute(
    db.db,
  );
  return rows.rows[0]!;
}

/** Creates one topup notification (+deliveries) for the push channel. */
async function topupPush(userId: string, version: string): Promise<string> {
  const emit = await emitNotificationEvent(db, {
    eventType: 'payments.topup.captured',
    aggregateType: 'wallet_topup',
    aggregateVersion: version,
    payload: { userId, amountPaise: '10000' },
  });
  await consumeEvent(db, pipeline, emit);
  const rows = await sql<{
    id: string;
  }>`SELECT id FROM notifications WHERE user_id=${userId}::uuid AND channel='PUSH' AND template_key='wallet.topup' ORDER BY created_at DESC LIMIT 1`.execute(
    db.db,
  );
  return rows.rows[0]!.id;
}

beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl, 10);
  world = await seedNotificationsWorld(db);
  push = new FakePush();
  email = new FakeEmail();
  pipeline = new PostgresNotificationPipeline(
    db.db,
    push,
    email,
    undefined,
    new TestAppConfig(db.db),
  );
  views = new PostgresNotificationViews(db.db);
}, 120_000);

afterAll(async () => {
  await db.close();
  await services.stop();
}, 60_000);

describe('channel delivery pump', () => {
  test('provider outage retries with recorded attempts, then recovers (RTN-03)', async () => {
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) VALUES(${uuid(30)}::uuid,${world.customer}::uuid,'pump-token-0123456789abcd','ANDROID','CUSTOMER')`.execute(
      db.db,
    );
    const notificationId = await topupPush(world.customer, '11');
    push.failNext = 2;
    const first = await pipeline.deliverOnce((await deliveryRow(notificationId)).id, new Date());
    expect(first).toBe('RETRY');
    const attempt1 = await deliveryRow(notificationId);
    expect(attempt1.status).toBe('PENDING');
    expect(attempt1.attempts).toBe(1);
    expect(attempt1.last_error).toContain('ExternalServiceUnavailable');
    expect(await pipeline.deliverOnce(attempt1.id, new Date())).toBe('IDLE');
    await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp() WHERE id=${attempt1.id}::uuid`.execute(
      db.db,
    );
    await pipeline.deliverOnce(attempt1.id, new Date());
    expect((await deliveryRow(notificationId)).attempts).toBe(2);
    // Recovery: the third attempt succeeds and records the provider message id.
    await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp() WHERE id=${attempt1.id}::uuid`.execute(
      db.db,
    );
    const third = await pipeline.deliverOnce((await deliveryRow(notificationId)).id, new Date());
    expect(third).toBe('SENT');
    const done = await deliveryRow(notificationId);
    expect(done.status).toBe('SENT');
    expect(done.last_error).toBeNull();
    expect(push.sent.length).toBe(1); // the fake records successful sends only
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM notifications WHERE id=${notificationId}::uuid`.execute(db.db)
      ).rows[0]!.status,
    ).toBe('SENT');
  });

  test('exhausted attempts land in the durable dead state without throwing', async () => {
    const bounded = new PostgresNotificationPipeline(
      db.db,
      push,
      email,
      undefined,
      new TestAppConfig(db.db),
      2,
    );
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) VALUES(${uuid(31)}::uuid,${world.customerTe}::uuid,'pump-token-dead0123456','ANDROID','CUSTOMER')`.execute(
      db.db,
    );
    const emit = await emitNotificationEvent(db, {
      eventType: 'payments.topup.captured',
      aggregateType: 'wallet_topup',
      aggregateVersion: '21',
      payload: { userId: world.customerTe, amountPaise: '7000' },
    });
    await consumeEvent(db, bounded, emit);
    const rows = await sql<{
      id: string;
    }>`SELECT id FROM notifications WHERE user_id=${world.customerTe}::uuid AND channel='PUSH' AND template_key='wallet.topup' ORDER BY created_at DESC LIMIT 1`.execute(
      db.db,
    );
    const delivery = await deliveryRow(rows.rows[0]!.id);
    push.failNext = 5;
    expect(await bounded.deliverOnce(delivery.id, new Date())).toBe('RETRY');
    await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp() WHERE id=${delivery.id}::uuid`.execute(
      db.db,
    );
    expect(await bounded.deliverOnce(delivery.id, new Date())).toBe('FAILED');
    const dead = await deliveryRow(rows.rows[0]!.id);
    expect(dead.status).toBe('FAILED');
    expect(dead.attempts).toBe(2);
    expect(
      (
        await sql<{
          status: string;
          error: string;
        }>`SELECT status,error FROM notifications WHERE id=${rows.rows[0]!.id}::uuid`.execute(db.db)
      ).rows[0]!,
    ).toMatchObject({ status: 'FAILED', error: 'ExternalServiceUnavailable' });
    expect(await bounded.deliverOnce(delivery.id, new Date())).toBe('IDLE'); // terminal: no resend
  });

  test('a failed send never rolls back committed producer work (RTN-03)', async () => {
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) VALUES(${uuid(34)}::uuid,${world.other}::uuid,'rollback-token-012345678','ANDROID','CUSTOMER')`.execute(
      db.db,
    );
    push.failNext = 1;
    const notificationId = await topupPush(world.other, '31');
    const delivery = await deliveryRow(notificationId);
    // The consumer delivery obligation completed before any provider attempt.
    const completed = await sql<{
      completed_at: Date | null;
    }>`SELECT completed_at FROM outbox_deliveries WHERE consumer='notifications' AND completed_at IS NOT NULL LIMIT 1`.execute(
      db.db,
    );
    expect(completed.rows[0]?.completed_at).not.toBeNull();
    await pipeline.deliverOnce(delivery.id, new Date());
    // The notification row survives the provider failure with its state intact.
    const after = await sql<{
      status: string;
    }>`SELECT status FROM notifications WHERE id=${notificationId}::uuid`.execute(db.db);
    expect(after.rows[0]!.status).toBe('PENDING');
    expect((await deliveryRow(notificationId)).attempts).toBe(1);
  });
});

describe('recovery scan and concern queue', () => {
  test('the scan re-kicks due deliveries through the notifications concern queue', async () => {
    const concerns = new ConcernQueues({
      redisUrl: services.redisUrl,
      prefix: services.redisPrefix,
    });
    const wired = new PostgresNotificationPipeline(
      db.db,
      push,
      email,
      concerns,
      new TestAppConfig(db.db),
    );
    concerns.register('notifications', 'deliver', async (data) => {
      const deliveryId = (data as { deliveryId: string }).deliveryId;
      await wired.deliverOnce(deliveryId);
    });
    try {
      await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) VALUES(${uuid(32)}::uuid,${world.admin}::uuid,'scan-token-0123456789cde','ANDROID','ADMIN')`.execute(
        db.db,
      );
      // Queue loss is simulated by creating the delivery without any enqueue.
      const emit = await emitNotificationEvent(db, {
        eventType: 'dispatch.no_rider',
        aggregateType: 'order',
        aggregateVersion: '41',
        payload: { orderId: uuid(33) },
      });
      await consumeEvent(db, wired, emit);
      const rows = await sql<{
        id: string;
      }>`SELECT id FROM notifications WHERE user_id=${world.admin}::uuid AND channel='PUSH' AND template_key='admin.no_riders' ORDER BY created_at DESC LIMIT 1`.execute(
        db.db,
      );
      const delivery = await deliveryRow(rows.rows[0]!.id);
      expect(delivery.status).toBe('PENDING');
      expect(await wired.enqueueDue(10)).toBeGreaterThan(0);
      const deadline = Date.now() + 15_000;
      let status = delivery.status;
      while (status === 'PENDING' && Date.now() < deadline) {
        await delay(100);
        status = (await deliveryRow(rows.rows[0]!.id)).status;
      }
      expect(status).toBe('SENT');
    } finally {
      await concerns.close();
    }
  }, 30_000);
});

describe('notification event contracts', () => {
  test('records malformed known events and unsupported schema versions durably', async () => {
    const event = await emitNotificationEvent(db, {
      eventType: 'payments.topup.captured',
      payload: { amountPaise: '100' },
    });
    await consumeEvent(db, pipeline, event);
    const result = await sql<{
      reason: string;
    }>`SELECT reason FROM notification_event_errors WHERE event_id=${event.eventId}::uuid`.execute(
      db.db,
    );
    expect(result.rows[0]?.reason).toBe('INVALID_OR_UNSUPPORTED_PAYLOAD');
    const future = await emitNotificationEvent(db, {
      eventType: 'payments.topup.captured',
      schemaVersion: 2,
      payload: { userId: world.customer, amountPaise: '100' },
    });
    await consumeEvent(db, pipeline, future);
    const unsupported = await sql<{
      reason: string;
    }>`SELECT reason FROM notification_event_errors WHERE event_id=${future.eventId}::uuid`.execute(
      db.db,
    );
    expect(unsupported.rows[0]?.reason).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });
});

describe('leased push delivery integrity', () => {
  test('sends every device in bounded batches and retries only transient results', async () => {
    const user = uuid(901);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER','p9-batch','batch@example.invalid','batch')`.execute(
      db.db,
    );
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) SELECT gen_random_uuid(),${user}::uuid,'batch-token-'||lpad(n::text,8,'0'),'ANDROID','CUSTOMER' FROM generate_series(1,501) n`.execute(
      db.db,
    );
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) VALUES(gen_random_uuid(),${user}::uuid,'rider-app-token-00001','ANDROID','RIDER')`.execute(
      db.db,
    );
    const fake = new FakePush();
    const invalid = 'batch-token-00000001';
    const transient = 'batch-token-00000002';
    const permanent = 'batch-token-00000003';
    fake.scriptInvalid(invalid);
    fake.outcomes.set(permanent, {
      token: permanent,
      ok: false,
      invalidToken: false,
      retryable: false,
      messageId: null,
      error: 'PERMANENT',
    });
    fake.outcomes.set(transient, {
      token: transient,
      ok: false,
      invalidToken: false,
      messageId: null,
      error: 'UNAVAILABLE',
    });
    const worker = new PostgresNotificationPipeline(
      db.db,
      fake,
      email,
      undefined,
      new TestAppConfig(db.db),
    );
    const notificationId = await topupPush(user, '901');
    const delivery = await deliveryRow(notificationId);
    expect(await worker.deliverOnce(delivery.id)).toBe('RETRY');
    expect(fake.sent.map((batch) => batch.tokens.length).sort((a, b) => a - b)).toEqual([1, 500]);
    expect(fake.allTokens()).toHaveLength(501);
    expect(fake.allTokens()).not.toContain('rider-app-token-00001');
    fake.outcomes.delete(transient);
    await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp() WHERE id=${delivery.id}::uuid`.execute(
      db.db,
    );
    expect(await worker.deliverOnce(delivery.id)).toBe('SENT');
    expect(fake.sent.at(-1)!.tokens).toEqual([transient]);
    const result = await sql<{
      status: string;
      count: string;
    }>`SELECT status,count(*)::text AS count FROM notification_token_results WHERE delivery_id=${delivery.id}::uuid GROUP BY status`.execute(
      db.db,
    );
    expect(Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]))).toEqual({
      SENT: 499,
      INVALID: 1,
      FAILED: 1,
    });
  });

  test('concurrent workers cannot send the same live lease and expired claims recover', async () => {
    const user = uuid(902);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER','p9-race','race@example.invalid','race')`.execute(
      db.db,
    );
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app) VALUES(gen_random_uuid(),${user}::uuid,'race-token-0123456789','ANDROID','CUSTOMER')`.execute(
      db.db,
    );
    const fake = new FakePush();
    const worker = new PostgresNotificationPipeline(
      db.db,
      fake,
      email,
      undefined,
      new TestAppConfig(db.db),
    );
    const notificationId = await topupPush(user, '902');
    const delivery = await deliveryRow(notificationId);
    const results = await Promise.all([
      worker.deliverOnce(delivery.id),
      worker.deliverOnce(delivery.id),
    ]);
    expect(results.sort()).toEqual(['IDLE', 'SENT']);
    expect(fake.sent).toHaveLength(1);
    const next = await topupPush(user, '903');
    const expired = await deliveryRow(next);
    await sql`UPDATE notification_deliveries SET status='CLAIMED',lease_token=gen_random_uuid(),lease_until=clock_timestamp()-interval '1 second',attempts=1 WHERE id=${expired.id}::uuid`.execute(
      db.db,
    );
    expect(await worker.deliverOnce(expired.id)).toBe('SENT');
    const ambiguity = await sql<{
      ambiguous_sends: number;
    }>`SELECT ambiguous_sends FROM notification_deliveries WHERE id=${expired.id}::uuid`.execute(
      db.db,
    );
    expect(ambiguity.rows[0]!.ambiguous_sends).toBe(1);
  });
});

describe('inbox pagination and ownership (SEC-03)', () => {
  test('keyset pages traverse newest-first and stop at the end', async () => {
    const user = world.manager;
    for (let index = 0; index < 25; index += 1)
      await seedInboxRow(db, {
        userId: user,
        dedupeKey: `page-${index}`,
        createdAt: new Date(Date.UTC(2026, 10, 7, 10, 0, index)),
      });
    const page1 = await views.inbox(user, undefined, 10);
    expect(page1.items.length).toBe(10);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await views.inbox(user, page1.nextCursor!, 10);
    expect(page2.items.length).toBe(10);
    const seen = new Set([...page1.items, ...page2.items].map((item) => item.id));
    expect(seen.size).toBe(20);
    const page3 = await views.inbox(user, page2.nextCursor!, 10);
    expect(page3.items.length).toBe(5);
    expect(page3.nextCursor).toBeNull();
    expect(() => views.inbox(user, 'tampered-cursor', 10)).rejects.toThrow('INVALID_CURSOR');
  });

  test('pagination preserves PostgreSQL microsecond precision', async () => {
    const user = uuid(905);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER','p9-cursor','cursor@example.invalid','cursor')`.execute(
      db.db,
    );
    const first = await seedInboxRow(db, { userId: user, dedupeKey: 'p9-cursor-first' });
    const second = await seedInboxRow(db, { userId: user, dedupeKey: 'p9-cursor-second' });
    await sql`UPDATE notifications SET created_at=CASE WHEN id=${first}::uuid THEN '2026-11-07 10:00:00.123900+00'::timestamptz ELSE '2026-11-07 10:00:00.123100+00'::timestamptz END WHERE id=ANY(${[first, second]}::uuid[])`.execute(
      db.db,
    );
    const page = await views.inbox(user, undefined, 1);
    expect(page.items[0]!.id).toBe(first);
    const next = await views.inbox(user, page.nextCursor!, 1);
    expect(next.items[0]!.id).toBe(second);
  });

  test('inbox excludes other channels and held rows and renders an English fallback', async () => {
    const user = uuid(904);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER','p9-inbox','inbox@example.invalid','inbox')`.execute(
      db.db,
    );
    const visible = await seedInboxRow(db, {
      userId: user,
      dedupeKey: 'p9-visible',
      templateKey: 'store.new_order',
    });
    await seedInboxRow(db, { userId: user, dedupeKey: 'p9-push', channel: 'PUSH' });
    const held = await seedInboxRow(db, {
      userId: user,
      dedupeKey: 'p9-held',
      status: 'QUIET_HELD',
    });
    await sql`UPDATE notifications SET locale='te',payload='{ "data": { "orderNumber": "ABC" } }'::jsonb WHERE id=${visible}::uuid`.execute(
      db.db,
    );
    const page = await views.inbox(user);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: visible,
      title: 'New order',
      body: 'Order ABC is ready for fulfillment.',
    });
    expect(await views.unreadCount(user)).toBe(1);
    await expect(views.markRead(user, held)).rejects.toThrow('RESOURCE_NOT_FOUND');
    await views.markRead(user, visible);
    await views.markRead(user, visible);
    expect(await views.unreadCount(user)).toBe(0);
  });

  test('customer HTTP inbox and mark-read enforce notification ownership', async () => {
    await sql`INSERT INTO user_roles(user_id,role) VALUES (${world.customer}::uuid,'CUSTOMER'),(${world.other}::uuid,'CUSTOMER') ON CONFLICT DO NOTHING`.execute(
      db.db,
    );
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
    });
    const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
    const owner = await tokens.issue('CUSTOMER', 'notify-cust', 'customer', 'access');
    const other = await tokens.issue('CUSTOMER', 'notify-other', 'customer', 'access');
    const notification = await seedInboxRow(db, {
      userId: world.customer,
      dedupeKey: 'http-owned',
    });
    const app = await createApplication(env, [{ name: 'test', async check() {} }]);
    try {
      const http = app.getHttpAdapter().getInstance();
      const ownerHeaders = { authorization: `Bearer ${owner}` };
      const otherHeaders = { authorization: `Bearer ${other}` };
      const ownerInbox = await http.inject({
        method: 'GET',
        url: '/v1/customer/notifications',
        headers: ownerHeaders,
      });
      const otherInbox = await http.inject({
        method: 'GET',
        url: '/v1/customer/notifications',
        headers: otherHeaders,
      });
      expect(ownerInbox.statusCode).toBe(200);
      expect(ownerInbox.json().items.map((item: { id: string }) => item.id)).toContain(
        notification,
      );
      expect(otherInbox.statusCode).toBe(200);
      expect(otherInbox.json().items.map((item: { id: string }) => item.id)).not.toContain(
        notification,
      );
      expect(
        (
          await http.inject({
            method: 'POST',
            url: `/v1/customer/notifications/${notification}/read`,
            headers: otherHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await http.inject({
            method: 'POST',
            url: `/v1/customer/notifications/${notification}/read`,
            headers: ownerHeaders,
          })
        ).statusCode,
      ).toBe(201);
      const repeated = await http.inject({
        method: 'POST',
        url: `/v1/customer/notifications/${notification}/read`,
        headers: ownerHeaders,
      });
      expect(repeated.statusCode).toBe(201);
      expect(repeated.json()).toEqual({ read: true });
    } finally {
      await app.close();
    }
  });

  test("another user's notification is 404, never leaked", async () => {
    const mine = await seedInboxRow(db, { userId: world.customer, dedupeKey: 'own-1' });
    await expect(views.markRead(world.other, mine)).rejects.toThrow('RESOURCE_NOT_FOUND');
    const otherPage = await views.inbox(world.other);
    expect(otherPage.items.map((item) => item.id)).not.toContain(mine);
    await views.markAllRead(world.customer);
    expect(await views.unreadCount(world.customer)).toBe(0);
  });
});

describe('DLQ growth alert', () => {
  test('alerts admins once per hour when dead letters accumulate', async () => {
    const alerts = new DlqGrowthAlert(db.db, pipeline, 3);
    for (let index = 0; index < 3; index += 1) {
      const id = await seedInboxRow(db, {
        userId: world.customer,
        dedupeKey: `dlq-${index}`,
        status: 'FAILED',
      });
      await sql`INSERT INTO notification_deliveries(id,notification_id,channel,status,last_error,updated_at) VALUES(${uuid(40 + index)}::uuid,${id}::uuid,'PUSH','FAILED','ExternalServiceUnavailable',clock_timestamp())`.execute(
        db.db,
      );
    }
    const before = await views.unreadCount(world.admin);
    expect(await alerts.runOnce()).toBe(1);
    const alert = await sql<{
      id: string;
    }>`SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=${world.admin}::uuid AND n.template_key='admin.dlq_growth'`.execute(
      db.db,
    );
    await pipeline.deliverOnce(alert.rows[0]!.id);
    expect(await views.unreadCount(world.admin)).toBe(before + 1);
    expect(await alerts.runOnce()).toBe(0); // dedupe: one alert per hour
    expect(await views.unreadCount(world.admin)).toBe(before + 1);
  });
});
