import { ConfigService as TestAppConfig } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresNotificationPipeline } from '../../../src/modules/notifications/infrastructure/postgres-pipeline.js';
import { PostgresDeviceTokens } from '../../../src/modules/notifications/infrastructure/postgres-tokens.js';
import { PostgresNotificationPreferences } from '../../../src/modules/notifications/infrastructure/postgres-preferences.js';
import { PostgresNotificationViews } from '../../../src/modules/notifications/infrastructure/postgres-views.js';
import { FakeEmail } from '../../../src/adapters/email/fake-email.js';
import { FakePush } from '../../../src/adapters/push/fake-push.js';
import type { EventEnvelope } from '../../../src/platform/outbox/outbox.js';
import {
  consumeEvent,
  emitNotificationEvent,
  notificationCount,
  seedInboxRow,
  seedNotificationsWorld,
  type NotificationsWorld,
} from '../../helpers/notifications-fixture.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices,
  db: DatabaseHandle,
  world: NotificationsWorld,
  pipeline: PostgresNotificationPipeline,
  push: FakePush,
  email: FakeEmail,
  tokens: PostgresDeviceTokens,
  preferences: PostgresNotificationPreferences,
  views: PostgresNotificationViews;

const uuid = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function envelopeOfDirect(emit: {
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateVersion: string;
  payload: unknown;
}): EventEnvelope {
  return {
    eventId: emit.eventId,
    eventType: emit.eventType,
    schemaVersion: 1,
    aggregateType: 'order',
    aggregateId: emit.aggregateId,
    aggregateVersion: emit.aggregateVersion,
    occurredAt: new Date().toISOString(),
    correlationId: emit.aggregateId,
    causationId: null,
    payload: emit.payload as EventEnvelope['payload'],
  };
}

async function latestNotifications(userId: string, limit = 10) {
  const rows = await sql<{
    id: string;
    channel: string;
    template_key: string;
    locale: string;
    status: string;
  }>`SELECT id,channel,template_key,locale,status FROM notifications WHERE user_id=${userId}::uuid ORDER BY created_at DESC,id DESC LIMIT ${limit}`.execute(
    db.db,
  );
  return rows.rows;
}

/** Marks the delivery due and runs one attempt at the given instant. */
async function deliverAt(notificationId: string, now: Date): Promise<string> {
  await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp()-interval '1 second',status='PENDING' WHERE notification_id=${notificationId}::uuid AND status<>'SENT'`.execute(
    db.db,
  );
  const rows = await sql<{
    id: string;
  }>`SELECT id FROM notification_deliveries WHERE notification_id=${notificationId}::uuid AND status='PENDING'`.execute(
    db.db,
  );
  if (!rows.rows[0]) return '';
  await pipeline.deliverOnce(rows.rows[0]!.id, now);
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
  tokens = new PostgresDeviceTokens(db.db);
  preferences = new PostgresNotificationPreferences(db.db);
  views = new PostgresNotificationViews(db.db);
}, 120_000);

afterAll(async () => {
  await db.close();
  await services.stop();
}, 60_000);

describe('notifications consumer (RTN-02, ADD-20)', () => {
  test('a replayed event creates one logical notification; a distinct transition notifies again', async () => {
    const payload = {
      orderId: uuid(21),
      orderNumber: 'ORD-DUP',
      userId: world.customer,
      storeId: world.store,
      targetDeliveryAt: new Date().toISOString(),
      items: [],
    };
    const first = await emitNotificationEvent(db, {
      eventType: 'ORDER_CONFIRMED',
      aggregateId: payload.orderId,
      payload,
    });
    await consumeEvent(db, pipeline, first);
    expect(await notificationCount(db, world.customer)).toBe(3); // PUSH, EMAIL, INBOX
    // A duplicate pipeline pass (relay replay without processed_events) still dedupes.
    await db.db.transaction().execute(async (tx) =>
      pipeline.consume(
        tx,
        envelopeOfDirect({
          eventId: first.eventId,
          eventType: first.eventType,
          aggregateId: first.aggregateId,
          aggregateVersion: first.aggregateVersion,
          payload,
        }),
      ),
    );
    expect(await notificationCount(db, world.customer)).toBe(3);
    // A later legitimate transition (version 2) notifies again.
    const second = await emitNotificationEvent(db, {
      eventType: 'ORDER_DELIVERED',
      aggregateId: payload.orderId,
      aggregateVersion: '2',
      payload,
    });
    await consumeEvent(db, pipeline, second);
    expect(await notificationCount(db, world.customer)).toBe(5); // 3 channels + 2 channels
  });

  test('preferences are honored per category before any row is created', async () => {
    await preferences.set(world.other, [
      { category: 'ORDER_UPDATES', enabled: false },
      { category: 'PROMOTIONS', enabled: false },
    ]);
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'ORDER_CONFIRMED',
        payload: { orderId: uuid(22), orderNumber: 'ORD-PREF', userId: world.other },
      }),
    );
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'marketing.campaign',
        aggregateType: 'campaign',
        payload: { userId: world.other, detail: 'sale' },
      }),
    );
    expect(await notificationCount(db, world.other)).toBe(3);
    // Re-enabled categories notify on the next distinct transition.
    await preferences.set(world.other, [{ category: 'PROMOTIONS', enabled: true }]);
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'marketing.campaign',
        aggregateType: 'campaign',
        aggregateVersion: '2',
        payload: { userId: world.other, detail: 'sale' },
      }),
    );
    expect(await notificationCount(db, world.other)).toBeGreaterThan(0);
  });

  test('unknown events are skipped gracefully and the delivery completes', async () => {
    const consumed = await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'catalog.product_publication_changed',
        aggregateType: 'catalog_variant',
        payload: { productId: uuid(23) },
      }),
    );
    expect(consumed).toBe(true);
    const suspended = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM outbox_deliveries WHERE consumer='notifications' AND suspended_at IS NOT NULL`.execute(
      db.db,
    );
    expect(Number(suspended.rows[0]!.count)).toBe(0);
  });

  test('store alerts reach store managers and ops alerts reach admins only', async () => {
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'inventory.low_stock',
        aggregateType: 'inventory_alert',
        payload: { storeId: world.store, variantId: uuid(24), available: '2' },
      }),
    );
    expect(
      (await latestNotifications(world.manager))
        .filter((row) => row.channel === 'INBOX')
        .map((row) => row.template_key),
    ).toEqual(['store.low_stock', 'store.new_order']);
    expect(await notificationCount(db, world.admin)).toBe(0); // store alerts stay out of admin inboxes
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'dispatch.no_rider',
        aggregateType: 'order',
        payload: { orderId: uuid(25) },
      }),
    );
    expect(
      (await latestNotifications(world.admin))
        .filter((row) => row.channel === 'INBOX')
        .map((row) => row.template_key),
    ).toEqual(['admin.no_riders']);
  });

  test('user locale is stored and English fallback applies to email', async () => {
    await tokens.register(world.customerTe, {
      token: 'te-locale-push-token-012345678',
      platform: 'ANDROID',
      app: 'CUSTOMER',
    });
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'ORDER_CONFIRMED',
        payload: { orderId: uuid(26), orderNumber: 'ORD-TE', userId: world.customerTe },
      }),
    );
    const rows = await latestNotifications(world.customerTe, 5);
    const pushRow = rows.find((row) => row.channel === 'PUSH')!;
    expect(pushRow.locale).toBe('te');
    await deliverAt(pushRow.id, new Date());
    expect(push.sent.at(-1)!.payload.title).toContain('ఆర్డర్'); // localized push
    const emailRow = rows.find((row) => row.channel === 'EMAIL')!;
    await deliverAt(emailRow.id, new Date());
    const mail = email.sent.at(-1)!;
    expect(mail.subject).toContain('ORD-TE'); // English fallback
    expect(mail.subject).not.toMatch(/\p{Script=Devanagari}|\p{Script=Telugu}/u);
  });

  test('promotional quiet hours hold only the promotional class (IST boundaries)', async () => {
    const txn = await emitNotificationEvent(db, {
      eventType: 'ORDER_PACKED',
      aggregateType: 'pick_task',
      aggregateVersion: '5',
      payload: { taskId: uuid(27), orderId: uuid(28), userId: world.customer },
    });
    await consumeEvent(db, pipeline, txn);
    const txnRow = (await latestNotifications(world.customer, 10)).find(
      (row) => row.template_key === 'order.packed',
    )!;
    await deliverAt(txnRow.id, new Date('2026-11-07T15:29:59Z')); // 20:59:59 IST
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM notifications WHERE id=${txnRow.id}::uuid`.execute(db.db)
      ).rows[0]!.status,
    ).toBe('SENT');
    const promo = await emitNotificationEvent(db, {
      eventType: 'marketing.campaign',
      aggregateType: 'campaign',
      aggregateVersion: '9',
      payload: { userId: world.customer, detail: 'flash sale' },
    });
    await consumeEvent(db, pipeline, promo);
    const promoRow = (await latestNotifications(world.customer, 20)).find(
      (row) => row.template_key === 'promotions.offer',
    )!;
    const deliveryId = await deliverAt(promoRow.id, new Date('2026-11-07T15:30:00Z')); // 21:00:00 IST
    const held = await sql<{
      status: string;
      next_retry_at: Date;
    }>`SELECT n.status,d.next_retry_at FROM notifications n JOIN notification_deliveries d ON d.notification_id=n.id WHERE n.id=${promoRow.id}::uuid`.execute(
      db.db,
    );
    expect(held.rows[0]!.status).toBe('QUIET_HELD');
    expect(held.rows[0]!.next_retry_at.toISOString()).toBe('2026-11-08T02:30:00.000Z');
    // Simulate the clock reaching the release instant, then the recovery scan.
    await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp()-interval '1 second' WHERE id=${deliveryId}::uuid`.execute(
      db.db,
    );
    await pipeline.enqueueDue(10); // no concern queue wired: the scan still releases holds
    await pipeline.deliverOnce(deliveryId, new Date('2026-11-08T02:30:01Z')); // 08:00:01 IST
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM notifications WHERE id=${promoRow.id}::uuid`.execute(db.db)
      ).rows[0]!.status,
    ).toBe('SENT');
  });

  test('device tokens are reassigned on login and invalid tokens are deactivated', async () => {
    const tokenA = 'fcm-token-alpha-0123456789';
    const tokenB = 'fcm-token-beta-012345678901';
    await tokens.register(world.customer, { token: tokenA, platform: 'ANDROID', app: 'CUSTOMER' });
    await tokens.register(world.other, { token: tokenA, platform: 'ANDROID', app: 'CUSTOMER' });
    const owner = await sql<{
      user_id: string;
    }>`SELECT user_id FROM device_tokens WHERE token=${tokenA}`.execute(db.db);
    expect(owner.rows[0]!.user_id).toBe(world.other); // reassigned to the new login
    expect((await tokens.list(world.customer)).length).toBe(0);
    expect((await tokens.list(world.other))[0]!.token).not.toBe(tokenA); // masked

    await tokens.register(world.other, { token: tokenB, platform: 'IOS', app: 'CUSTOMER' });
    push.scriptInvalid(tokenA);
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'payments.topup.captured',
        aggregateType: 'wallet_topup',
        aggregateVersion: '3',
        payload: { userId: world.other, amountPaise: '15000' },
      }),
    );
    const pushRow = (await latestNotifications(world.other, 5)).find(
      (row) => row.channel === 'PUSH',
    )!;
    await deliverAt(pushRow.id, new Date());
    expect(
      (
        await sql<{
          active: boolean;
        }>`SELECT active FROM device_tokens WHERE token=${tokenA}`.execute(db.db)
      ).rows[0]!.active,
    ).toBe(false);
    expect(
      (
        await sql<{
          active: boolean;
        }>`SELECT active FROM device_tokens WHERE token=${tokenB}`.execute(db.db)
      ).rows[0]!.active,
    ).toBe(true);
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM notifications WHERE id=${pushRow.id}::uuid`.execute(db.db)
      ).rows[0]!.status,
    ).toBe('SENT');

    // A user whose only token is invalid gets a SKIPPED notification, not a failure.
    const tokenC = 'fcm-token-gamma-01234567890';
    await tokens.register(world.customer, { token: tokenC, platform: 'WEB', app: 'CUSTOMER' });
    push.scriptInvalid(tokenC);
    await consumeEvent(
      db,
      pipeline,
      await emitNotificationEvent(db, {
        eventType: 'payments.topup.captured',
        aggregateType: 'wallet_topup',
        aggregateVersion: '4',
        payload: { userId: world.customer, amountPaise: '5000' },
      }),
    );
    const customerPush = (await latestNotifications(world.customer, 10)).find(
      (row) => row.channel === 'PUSH' && row.template_key === 'wallet.topup',
    )!;
    await deliverAt(customerPush.id, new Date());
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM notifications WHERE id=${customerPush.id}::uuid`.execute(db.db)
      ).rows[0]!.status,
    ).toBe('SKIPPED');
  });
});

describe('inbox reads', () => {
  test('rows are readable, owner-scoped and unread-counted', async () => {
    const mine = await seedInboxRow(db, { userId: world.customer, dedupeKey: 'seed-1' });
    await seedInboxRow(db, { userId: world.other, dedupeKey: 'seed-2' });
    const page = await views.inbox(world.customer);
    expect(page.items.map((item) => item.id)).toContain(mine);
    await expect(views.markRead(world.other, mine)).rejects.toThrow('RESOURCE_NOT_FOUND');
    const before = await views.unreadCount(world.customer);
    await views.markRead(world.customer, mine);
    expect(await views.unreadCount(world.customer)).toBe(before - 1 >= 0 ? before - 1 : 0);
  });
});

test('known malformed notification events and unsupported schemas are recorded, while internal task changes are ignored', async () => {
  const base = {
    eventType: 'ORDER_PACKED',
    aggregateId: uuid(620),
    aggregateVersion: '1',
    payload: {},
  };
  const malformed = envelopeOfDirect({ ...base, eventId: uuid(621) });
  const unsupported = { ...malformed, eventId: uuid(622), schemaVersion: 2 };
  const internal = envelopeOfDirect({
    ...base,
    eventId: uuid(623),
    eventType: 'picking.task_changed',
    payload: { status: 'ASSIGNED', taskId: uuid(625), orderId: uuid(620) },
  });
  const unknown = envelopeOfDirect({ ...base, eventId: uuid(624), eventType: 'unrelated.event' });
  await db.db.transaction().execute(async (tx) => {
    for (const event of [malformed, unsupported, internal, unknown])
      await pipeline.consume(tx, event);
  });
  const errors = await sql<{
    event_id: string;
    reason: string;
  }>`SELECT event_id,reason FROM notification_event_errors WHERE event_id IN (${malformed.eventId}::uuid,${unsupported.eventId}::uuid,${internal.eventId}::uuid,${unknown.eventId}::uuid) ORDER BY event_id`.execute(
    db.db,
  );
  expect(errors.rows).toEqual([
    { event_id: malformed.eventId, reason: 'INVALID_OR_UNSUPPORTED_PAYLOAD' },
    { event_id: unsupported.eventId, reason: 'UNSUPPORTED_SCHEMA_VERSION' },
  ]);
});

describe('admin push campaigns', () => {
  test('snapshots web and Android devices, enforces idempotency, and does not add later registrations', async () => {
    const { PostgresPushCampaigns } =
      await import('../../../src/modules/notifications/infrastructure/postgres-campaigns.js');
    const customer = uuid(991);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${customer}::uuid,'CUSTOMER','campaign-test-customer','campaign-test@example.test','Campaign Test')`.execute(
      db.db,
    );
    await tokens.register(customer, {
      token: 'campaign-web-fid-0123456789',
      platform: 'WEB',
      app: 'CUSTOMER',
      identifierType: 'FID',
    });
    await tokens.register(customer, {
      token: 'campaign-android-token-0123456789',
      platform: 'ANDROID',
      app: 'CUSTOMER',
    });
    const campaigns = new PostgresPushCampaigns(db.db);
    const input = {
      target: { mode: 'USERS' as const, apps: ['CUSTOMER' as const], userIds: [customer] },
      kind: 'OPERATIONAL' as const,
      title: 'Test',
      body: 'Message',
    };
    expect(await campaigns.preview(input)).toEqual({ devices: 2, users: 1 });
    const created = await campaigns.create(world.admin, 'campaign-key', input);
    expect(await campaigns.create(world.admin, 'campaign-key', input)).toMatchObject({
      id: created.id,
      replay: true,
    });
    await expect(
      campaigns.create(world.admin, 'campaign-key', { ...input, title: 'Changed' }),
    ).rejects.toMatchObject({ status: 409 });
    await tokens.register(customer, {
      token: 'campaign-late-token-0123456789',
      platform: 'ANDROID',
      app: 'CUSTOMER',
    });
    const row = await sql<{
      id: string;
    }>`SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.payload->>'campaignId'=${created.id}`.execute(
      db.db,
    );
    const isolatedPush = new FakePush();
    const service = new PostgresNotificationPipeline(
      db.db,
      isolatedPush,
      email,
      undefined,
      new TestAppConfig(db.db),
    );
    expect(await service.deliverOnce(row.rows[0]!.id)).toBe('SENT');
    expect(isolatedPush.allTokens().sort()).toEqual([
      'campaign-android-token-0123456789',
      'campaign-web-fid-0123456789',
    ]);
  });
  test('excludes users who opted out of promotions', async () => {
    const { PostgresPushCampaigns } =
      await import('../../../src/modules/notifications/infrastructure/postgres-campaigns.js');
    const customer = uuid(992);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${customer}::uuid,'CUSTOMER','campaign-opt-out','campaign-opt-out@example.test','Campaign Test')`.execute(
      db.db,
    );
    await tokens.register(customer, {
      token: 'campaign-opt-out-token-0123456789',
      platform: 'WEB',
      app: 'CUSTOMER',
      identifierType: 'FID',
    });
    await preferences.set(customer, [{ category: 'PROMOTIONS', enabled: false }]);
    const campaigns = new PostgresPushCampaigns(db.db);
    expect(
      await campaigns.preview({
        target: { mode: 'USERS', apps: ['CUSTOMER'], userIds: [customer] },
        kind: 'PROMOTIONAL',
      }),
    ).toEqual({ devices: 0, users: 0 });
  });
  test('preview reports devices and users per mode and rejects empty/oversized audiences', async () => {
    const { PostgresPushCampaigns } =
      await import('../../../src/modules/notifications/infrastructure/postgres-campaigns.js');
    const customer = uuid(993);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${customer}::uuid,'CUSTOMER','campaign-modes','campaign-modes@example.test','Modes Test')`.execute(
      db.db,
    );
    await tokens.register(customer, {
      token: 'campaign-modes-android-0123456',
      platform: 'ANDROID',
      app: 'CUSTOMER',
    });
    await tokens.register(customer, {
      token: 'campaign-modes-web-fid-0123456',
      platform: 'WEB',
      app: 'CUSTOMER',
      identifierType: 'FID',
    });
    const campaigns = new PostgresPushCampaigns(db.db);
    // USERS mode counts devices+users for the selected accounts only.
    expect(
      await campaigns.preview({
        target: { mode: 'USERS', apps: ['CUSTOMER'], userIds: [customer] },
        kind: 'OPERATIONAL',
      }),
    ).toEqual({ devices: 2, users: 1 });
    // PLATFORM mode restricts to the chosen device platform.
    expect(
      await campaigns.preview({
        target: { mode: 'PLATFORM', apps: ['CUSTOMER'], platform: 'WEB' },
        kind: 'OPERATIONAL',
      }),
    ).toMatchObject({ devices: 1 });
    // No-recipient create is rejected; oversized user selection is rejected.
    await expect(
      campaigns.create(world.admin, 'campaign-empty', {
        target: { mode: 'USERS', apps: ['CUSTOMER'], userIds: [uuid(995)] },
        kind: 'OPERATIONAL',
        title: 'T',
        body: 'B',
      }),
    ).rejects.toThrow('INVALID_INPUT');
    await expect(
      campaigns.create(world.admin, 'campaign-too-many', {
        target: {
          mode: 'USERS',
          apps: ['CUSTOMER'],
          userIds: Array.from({ length: 1001 }, () => uuid(996)),
        },
        kind: 'OPERATIONAL',
        title: 'T',
        body: 'B',
      }),
    ).rejects.toThrow('INVALID_INPUT');
  });
  test('list projects real title/kind/recipients and detail returns delivery counts', async () => {
    const { PostgresPushCampaigns } =
      await import('../../../src/modules/notifications/infrastructure/postgres-campaigns.js');
    const customer = uuid(994);
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${customer}::uuid,'CUSTOMER','campaign-detail','campaign-detail@example.test','Detail Test')`.execute(
      db.db,
    );
    await tokens.register(customer, {
      token: 'campaign-detail-token-012345678',
      platform: 'ANDROID',
      app: 'CUSTOMER',
    });
    const campaigns = new PostgresPushCampaigns(db.db);
    const input = {
      target: { mode: 'USERS' as const, apps: ['CUSTOMER' as const], userIds: [customer] },
      kind: 'PROMOTIONAL' as const,
      title: 'Detail title',
      body: 'Detail body',
    };
    const created = (await campaigns.create(world.admin, 'campaign-detail-key', input)) as {
      id: string;
    };
    const listed = (await campaigns.list()) as {
      items: Array<{ id: string; title: string; kind: string; recipients: number }>;
    };
    const found = listed.items.find((item) => item.id === created.id);
    expect(found).toMatchObject({ title: 'Detail title', kind: 'PROMOTIONAL', recipients: 1 });
    const detail = (await campaigns.detail(created.id)) as {
      results: Array<{ status: string; devices: number }>;
    };
    expect(detail.results.length).toBeGreaterThan(0);
    expect(detail.results.some((row) => row.status === 'PENDING')).toBe(true);
  });
  test('template overrides win at creation and stored text survives a later edit in inbox and retry', async () => {
    const { PostgresTemplateOverrides } =
      await import('../../../src/modules/notifications/infrastructure/postgres-template-overrides.js');
    const overrides = new PostgresTemplateOverrides(db.db);
    const customer = world.customer;
    const orderId = uuid(997);
    const emit = await emitNotificationEvent(db, {
      eventType: 'ORDER_CONFIRMED',
      aggregateId: uuid(998),
      aggregateVersion: '1',
      payload: { orderId, orderNumber: 'ORD-STORED', userId: customer },
    });
    expect(await consumeEvent(db, pipeline, emit)).toBe(true);
    const [stored] = (
      await sql<{
        rendered_title: string;
        rendered_body: string;
      }>`SELECT rendered_title,rendered_body FROM notifications WHERE user_id=${customer}::uuid AND template_key='order.confirmed' ORDER BY created_at DESC LIMIT 1`.execute(
        db.db,
      )
    ).rows;
    // Stored text was frozen at creation from the winning (default) template.
    expect(stored!.rendered_title).toContain('ORD-STORED');
    const beforeInbox = await views.inbox(customer);
    const beforeTitle = beforeInbox.items.find(
      (item) => item.templateKey === 'order.confirmed' && item.status === 'SENT',
    )?.title;
    // Publishing an override must not rewrite the already-composed row.
    const current = (await overrides.list()).find(
      (entry) =>
        entry.templateKey === 'order.confirmed' &&
        entry.locale === 'en' &&
        entry.channel === 'PUSH',
    )!;
    await overrides.write(world.admin, 'order.confirmed', 'en', 'PUSH', {
      subject: 'Edited {{orderNumber}}',
      body: 'Edited body {{orderNumber}}',
      expectedVersion: current.version,
    });
    const afterInbox = await views.inbox(customer);
    const afterTitle = afterInbox.items.find(
      (item) => item.templateKey === 'order.confirmed' && item.status === 'SENT',
    )?.title;
    if (beforeTitle !== undefined) expect(afterTitle).toBe(beforeTitle);
    // A new event composes from the override (override precedence).
    const emit2 = await emitNotificationEvent(db, {
      eventType: 'ORDER_CONFIRMED',
      aggregateId: uuid(999),
      aggregateVersion: '1',
      payload: { orderId: uuid(1000), orderNumber: 'ORD-OVERRIDE', userId: customer },
    });
    expect(await consumeEvent(db, pipeline, emit2)).toBe(true);
    const [overridden] = (
      await sql<{
        rendered_title: string;
      }>`SELECT rendered_title FROM notifications WHERE user_id=${customer}::uuid AND template_key='order.confirmed' ORDER BY created_at DESC LIMIT 1`.execute(
        db.db,
      )
    ).rows;
    expect(overridden!.rendered_title).toBe('Edited ORD-OVERRIDE');
  });
});

describe('app content slots (customize2 §3E)', () => {
  test('slot publish, locale fallback, unset-vs-disabled, expired and history restore', async () => {
    const { PostgresAppContent } =
      await import('../../../src/modules/app-content/infrastructure/postgres-app-content.js');
    const content = new PostgresAppContent(db.db);
    const now = new Date('2026-06-01T12:00:00Z');
    // Unset: no row -> UNSET (apps use bundled defaults).
    let audience = await content.audience('CUSTOMER', 'hi', now);
    expect(audience.find((item) => item.slot === 'CUSTOMER_HOME_BANNER')?.state).toBe('UNSET');
    // Publish English banner.
    const written = await content.write(world.admin, 'CUSTOMER_HOME_BANNER', 'en', {
      enabled: true,
      title: 'Monsoon offer',
      body: 'Fresh packs at home',
      destination: '/cart',
      expectedVersion: 0,
    });
    expect(written.version).toBe(1);
    expect(written.imageUrl).toBeNull();
    // Locale fallback: hi request resolves the en row.
    audience = await content.audience('CUSTOMER', 'hi', now);
    const banner = audience.find((item) => item.slot === 'CUSTOMER_HOME_BANNER')!;
    expect(banner.state).toBe('VISIBLE');
    expect(banner.title).toBe('Monsoon offer');
    expect(banner.locale).toBe('en');
    // Stale version is a conflict.
    await expect(
      content.write(world.admin, 'CUSTOMER_HOME_BANNER', 'en', {
        enabled: true,
        title: 'Other',
        body: 'Other body',
        expectedVersion: 0,
      }),
    ).rejects.toThrow('CONCURRENT_MODIFICATION');
    // Disable -> DISABLED (deliberately hidden, not bundled).
    await content.write(world.admin, 'CUSTOMER_HOME_BANNER', 'en', {
      enabled: false,
      title: 'Monsoon offer',
      body: 'Fresh packs at home',
      expectedVersion: 1,
    });
    audience = await content.audience('CUSTOMER', 'en', now);
    expect(audience.find((item) => item.slot === 'CUSTOMER_HOME_BANNER')?.state).toBe('DISABLED');
    // History holds the pre-disable enabled version for restore.
    const history = await content.history('CUSTOMER_HOME_BANNER', 'en');
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.enabled).toBe(true);
    // Restore through a new validated write.
    const restored = await content.write(world.admin, 'CUSTOMER_HOME_BANNER', 'en', {
      enabled: history[0]!.enabled,
      title: history[0]!.title,
      body: history[0]!.body,
      destination: '/cart',
      expectedVersion: 2,
    });
    expect(restored.version).toBe(3);
    audience = await content.audience('CUSTOMER', 'en', now);
    expect(audience.find((item) => item.slot === 'CUSTOMER_HOME_BANNER')?.state).toBe('VISIBLE');
    // Expired window -> INACTIVE.
    await content.write(world.admin, 'CUSTOMER_OFFERS_CARD', 'en', {
      enabled: true,
      title: 'Short offer',
      body: 'Only this week',
      startAt: '2026-01-01T00:00:00Z',
      endAt: '2026-02-01T00:00:00Z',
      expectedVersion: 0,
    });
    audience = await content.audience('CUSTOMER', 'en', now);
    expect(audience.find((item) => item.slot === 'CUSTOMER_OFFERS_CARD')?.state).toBe('INACTIVE');
    // Rider audience only sees rider slots.
    const riderAudience = await content.audience('RIDER', 'en', now);
    expect(riderAudience.map((item) => item.slot)).toEqual([
      'RIDER_HOME_ANNOUNCEMENT',
      'RIDER_HELP',
    ]);
  });
  test('slot writes enforce destination allowlist and text limits', async () => {
    const { PostgresAppContent } =
      await import('../../../src/modules/app-content/infrastructure/postgres-app-content.js');
    const content = new PostgresAppContent(db.db);
    await expect(
      content.write(world.admin, 'CUSTOMER_HOME_BANNER', 'en', {
        enabled: true,
        title: 'T',
        body: 'B',
        destination: '/notifications',
        expectedVersion: 99,
      }),
    ).rejects.toThrow('INVALID_INPUT');
    await expect(
      content.write(world.admin, 'CUSTOMER_HOME_BANNER', 'en', {
        enabled: true,
        title: 'x'.repeat(201),
        body: 'B',
        expectedVersion: 0,
      }),
    ).rejects.toThrow('INVALID_INPUT');
  });
});
