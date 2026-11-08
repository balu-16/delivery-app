import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { createP5World, closeP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
beforeAll(async () => {
  world = await createP5World();
  for (const [key, value] of [
    ['deliveryFeeSlabs', [{ maxOrderValuePaise: null, feePaise: '0' }]],
    ['freeDeliveryThresholdPaise', '0'],
    ['handlingFeePaise', '0'],
    ['smallCartThresholdPaise', '0'],
    ['smallCartFeePaise', '0'],
    ['surgeFeePaise', '0'],
  ] as const)
    await sql`INSERT INTO app_config(key,value) VALUES(${key},${JSON.stringify(value)}::jsonb)`.execute(
      world.db.db,
    );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true),('subscriptions_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    world.db.db,
  );
  await sql`INSERT INTO wallet_accounts(id,user_id,cash_balance_paise) VALUES(${uuidV7()}::uuid,${world.customer}::uuid,50000)`.execute(
    world.db.db,
  );
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
    }),
    [{ name: 'test', async check() {} }],
  );
}, 120000);
afterAll(async () => {
  await app?.close();
  await closeP5World(world);
}, 120000);
it('places and confirms a real wallet-funded scheduled order in the caller transaction', async () => {
  const variant = await world.variant({ price: 10000n, stock: 3n });
  const checkout = app.get<CheckoutOperations>(CHECKOUT);
  const start = new Date(Date.now() + 86400000),
    end = new Date(start.getTime() + 3600000);
  const placed = await world.db.db.transaction().execute((tx) =>
    checkout.placeScheduled(
      {
        userId: world.customer,
        subscriptionId: uuidV7(),
        deliveryDate: start.toISOString().slice(0, 10),
        storeId: world.store,
        addressId: world.address,
        variantId: variant.id,
        quantity: '1',
        slotStart: start.toISOString(),
        slotEnd: end.toISOString(),
      },
      tx,
    ),
  );
  const rows = await sql<{
    status: string;
    source: string;
    method: string;
    cash: string;
    reserved: string;
    ledgers: string;
  }>`SELECT o.status,o.source,o.payment_method AS method,a.cash_balance_paise::text AS cash,i.reserved::text AS reserved,(SELECT count(*)::text FROM wallet_ledger l WHERE l.ref_id=o.id::text AND reason='ORDER_PAYMENT') AS ledgers FROM orders o JOIN wallet_accounts a ON a.user_id=o.user_id JOIN store_inventory i ON i.store_id=o.store_id AND i.variant_id=${variant.id}::uuid WHERE o.id=${placed.orderId}::uuid`.execute(
    world.db.db,
  );
  expect(rows.rows[0]).toEqual({
    status: 'CONFIRMED',
    source: 'SUBSCRIPTION',
    method: 'WALLET',
    cash: '40000',
    reserved: '1',
    ledgers: '1',
  });
});

it('serializes simultaneous generation and records one occurrence, order and debit', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant({ price: 1000n, stock: 4n });
  const plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const today = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'06:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${today}::date,${today}::date,${today}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${today}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  const due = {
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: today,
  };
  await Promise.all([worker['process'](due), worker['process'](due)]);
  await worker['process'](due);
  const effect = await sql<{
    state: string;
    orders: string;
    debits: string;
    reserved: string;
  }>`SELECT o.state,(SELECT count(*)::text FROM orders WHERE metadata->>'subscriptionId'=${subscription}) AS orders,(SELECT count(*)::text FROM wallet_ledger l JOIN orders x ON l.ref_id=x.id::text WHERE x.metadata->>'subscriptionId'=${subscription} AND l.reason='ORDER_PAYMENT') AS debits,(SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved FROM subscription_occurrences o WHERE subscription_id=${subscription}::uuid AND delivery_date=${today}::date`.execute(
    world.db.db,
  );
  expect(effect.rows).toEqual([{ state: 'ORDERED', orders: '1', debits: '1', reserved: '1' }]);
});

it('reuses a low-balance occurrence after top-up without creating duplicate obligations', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant({ price: 1000n, stock: 3n });
  const plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`UPDATE wallet_accounts SET cash_balance_paise=0 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'06:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  const due = {
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: date,
  };
  await worker['process'](due);
  const retry = await sql<{
    state: string;
    order_id: string | null;
  }>`SELECT state,order_id::text FROM subscription_occurrences WHERE subscription_id=${subscription}::uuid`.execute(
    world.db.db,
  );
  expect(retry.rows).toEqual([{ state: 'RETRYABLE', order_id: null }]);
  await sql`UPDATE wallet_accounts SET cash_balance_paise=10000 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE subscription_occurrences SET retry_at=clock_timestamp()-interval '1 second' WHERE subscription_id=${subscription}::uuid`.execute(
    world.db.db,
  );
  await worker['process'](due);
  await worker['process'](due);
  const result = await sql<{
    state: string;
    orders: string;
    debits: string;
  }>`SELECT o.state,(SELECT count(*)::text FROM orders WHERE metadata->>'subscriptionId'=${subscription}) AS orders,(SELECT count(*)::text FROM wallet_ledger l JOIN orders x ON l.ref_id=x.id::text WHERE x.metadata->>'subscriptionId'=${subscription} AND l.reason='ORDER_PAYMENT') AS debits FROM subscription_occurrences o WHERE o.subscription_id=${subscription}::uuid`.execute(
    world.db.db,
  );
  expect(result.rows).toEqual([{ state: 'ORDERED', orders: '1', debits: '1' }]);
});

it('extends inclusive end date once for a holiday and records a terminal outcome on replay', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant({ price: 1000n, stock: 3n });
  const plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO app_config(key,value) VALUES('subscriptionExtendOnHoliday','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value='true'::jsonb`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'06:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_holidays(store_id,holiday_date) VALUES(${world.store}::uuid,${date}::date) ON CONFLICT DO NOTHING`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  const due = {
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: date,
  };
  await worker['process'](due);
  await worker['process'](due);
  const result = await sql<{
    end_date: string;
    next_date: string;
    state: string;
    reason: string;
    count: string;
  }>`SELECT s.end_date::text,s.next_delivery_date::text AS next_date,o.state,o.reason,(SELECT count(*)::text FROM subscription_occurrences WHERE subscription_id=s.id) AS count FROM subscriptions s JOIN subscription_occurrences o ON o.subscription_id=s.id WHERE s.id=${subscription}::uuid`.execute(
    world.db.db,
  );
  const expected = (
    await sql<{ date: string }>`SELECT (${date}::date+1)::text AS date`.execute(world.db.db)
  ).rows[0]!.date;
  expect(result.rows).toEqual([
    {
      end_date: expected,
      next_date: expected,
      state: 'SKIPPED',
      reason: 'SKIPPED_HOLIDAY',
      count: '1',
    },
  ]);
});

it('pauses active subscriptions atomically when their address is removed', async () => {
  const { ADDRESSES } = await import('../../../src/modules/addresses/contracts/tokens.js');
  const { SubscriptionObligationsModule } =
    await import('../../../src/modules/subscriptions/subscriptions-obligations.module.js');
  void SubscriptionObligationsModule;
  const variant = await world.variant();
  const plan = uuidV7(),
    subscription = uuidV7();
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.otherAddress}::uuid,current_date)`.execute(
    world.db.db,
  );
  const addresses = app.get<{ remove(user: string, id: string): Promise<void> }>(ADDRESSES);
  await addresses.remove(world.customer, world.otherAddress);
  const result = await sql<{
    status: string;
    deleted: boolean;
    alerts: string;
  }>`SELECT s.status,a.deleted_at IS NOT NULL AS deleted,(SELECT count(*)::text FROM outbox_events WHERE aggregate_id=s.id AND event_type='subscription.skipped' AND payload->>'reason'='ADDRESS_DELETED') AS alerts FROM subscriptions s JOIN addresses a ON a.id=s.address_id WHERE s.id=${subscription}::uuid`.execute(
    world.db.db,
  );
  expect(result.rows).toEqual([{ status: 'PAUSED', deleted: true, alerts: '1' }]);
});

it('serializes slot admission against incompatible grace configuration', async () => {
  const { SUBSCRIPTION_ADMIN } =
    await import('../../../src/modules/subscriptions/contracts/subscriptions.js');
  const { ADMIN_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const admin =
    app.get<
      import('../../../src/modules/subscriptions/contracts/subscriptions.js').SubscriptionAdmin
    >(SUBSCRIPTION_ADMIN);
  const config =
    app.get<import('../../../src/modules/app-config/contracts/config.js').AdminConfig>(
      ADMIN_CONFIG,
    );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${world.admin}::uuid,'SUPER_ADMIN') ON CONFLICT DO NOTHING`.execute(
    world.db.db,
  );
  await sql`UPDATE subscription_slots SET active=false WHERE store_id=${world.store}::uuid`.execute(
    world.db.db,
  );
  const results = await Promise.allSettled([
    admin.saveSlot(world.admin, {
      storeId: world.store,
      name: uuidV7(),
      startTime: '06:00',
      endTime: '09:00',
      active: true,
    }),
    config.update(world.admin, 'subscriptionGraceDeadlineTime', '05:40'),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const invalid = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM subscription_slots s WHERE s.active AND (extract(epoch FROM start_time)/60 - COALESCE((SELECT (value #>> '{}')::int FROM app_config WHERE key='subscriptionDispatchLeadMinutes'),30)) <= extract(epoch FROM COALESCE((SELECT value #>> '{}' FROM app_config WHERE key='subscriptionGraceDeadlineTime'),'05:25')::time)/60`.execute(
    world.db.db,
  );
  expect(invalid.rows[0]?.n).toBe('0');
});

it('persists and deduplicates projected low balance and price increase alerts', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant({ price: 1000n, stock: 3n }),
    plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`DELETE FROM subscription_holidays WHERE store_id=${world.store}::uuid AND holiday_date=${date}::date`.execute(
    world.db.db,
  );
  await sql`UPDATE wallet_accounts SET cash_balance_paise=0 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date,last_unit_price_paise) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date,500)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  await worker.forecast();
  await worker.forecast();
  await sql`UPDATE wallet_accounts SET cash_balance_paise=5000 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await worker['process']({
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: date,
  });
  const alerts = await sql<{
    kind: string;
    n: string;
  }>`SELECT kind,count(*)::text AS n FROM subscription_alerts WHERE subscription_id=${subscription}::uuid GROUP BY kind ORDER BY kind`.execute(
    world.db.db,
  );
  expect(alerts.rows).toEqual([
    { kind: 'LOW_BALANCE', n: '1' },
    { kind: 'PRICE_INCREASE', n: '1' },
  ]);
  const deliveries = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM outbox_events e JOIN outbox_deliveries d ON d.event_id=e.id WHERE e.payload->>'subscriptionId'=${subscription} AND e.event_type IN ('subscription.low_balance','subscription.price_increase') AND d.consumer='notifications'`.execute(
    world.db.db,
  );
  expect(deliveries.rows[0]?.n).toBe('2');
});

it('uses HTTP idempotency, rejects key reuse, and hides another customer subscription', async () => {
  const http = app.getHttpAdapter().getInstance();
  const issue = async (sub: string) => {
    const response = await http.inject({
      method: 'POST',
      url: '/dev/auth/token',
      payload: { pool: 'CUSTOMER', sub, audience: 'customer', tokenUse: 'access' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().token as string;
  };
  const customer = await issue('p5-customer'),
    other = await issue('p5-other');
  const variant = await world.variant(),
    plan = uuidV7(),
    slot = uuidV7();
  const start = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+2)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  const payload = {
    variantId: variant.id,
    quantity: '1',
    frequencyRule: { type: 'DAILY' },
    startDate: start,
    slotId: slot,
    addressId: world.address,
  };
  const headers = { authorization: `Bearer ${customer}`, 'idempotency-key': uuidV7() };
  const invalidFrequency = await http.inject({
    method: 'POST',
    url: '/v1/customer/subscriptions',
    headers: { authorization: `Bearer ${customer}`, 'idempotency-key': uuidV7() },
    payload: { ...payload, frequencyRule: { type: 'DAILY', unexpected: 'canary' } },
  });
  expect(invalidFrequency.statusCode).toBe(400);
  expect(invalidFrequency.json().code).toBe('INVALID_FREQUENCY');
  expect(invalidFrequency.body).not.toContain('canary');
  const created = await http.inject({
    method: 'POST',
    url: '/v1/customer/subscriptions',
    headers,
    payload,
  });
  expect(created.statusCode).toBe(201);
  const replay = await http.inject({
    method: 'POST',
    url: '/v1/customer/subscriptions',
    headers,
    payload,
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(created.json());
  const reused = await http.inject({
    method: 'POST',
    url: '/v1/customer/subscriptions',
    headers,
    payload: { ...payload, quantity: '2' },
  });
  expect(reused.statusCode).toBe(409);
  const foreign = await http.inject({
    method: 'GET',
    url: `/v1/customer/subscriptions/${created.json().id}`,
    headers: { authorization: `Bearer ${other}` },
  });
  expect(foreign.statusCode).toBe(404);
  const id = created.json().id as string;
  const beforeForeignChanges = await http.inject({
    method: 'GET',
    url: `/v1/customer/subscriptions/${id}`,
    headers: { authorization: `Bearer ${customer}` },
  });
  expect(beforeForeignChanges.statusCode).toBe(200);
  const invalidChange = await http.inject({
    method: 'PATCH',
    url: `/v1/customer/subscriptions/${id}`,
    headers: { authorization: `Bearer ${customer}`, 'idempotency-key': uuidV7() },
    payload: { frequencyRule: { type: 'WEEKDAYS', days: [1, 3], unexpected: 'canary' } },
  });
  expect(invalidChange.statusCode).toBe(400);
  expect(invalidChange.json().code).toBe('INVALID_FREQUENCY');
  expect(invalidChange.body).not.toContain('canary');
  const foreignOperations = [
    { method: 'GET' as const, url: `/v1/customer/subscriptions/${id}/upcoming` },
    {
      method: 'PATCH' as const,
      url: `/v1/customer/subscriptions/${id}`,
      payload: { quantity: '3' },
    },
    {
      method: 'POST' as const,
      url: `/v1/customer/subscriptions/${id}/pause`,
      payload: { from: start, to: start },
    },
    { method: 'POST' as const, url: `/v1/customer/subscriptions/${id}/resume` },
    {
      method: 'POST' as const,
      url: `/v1/customer/subscriptions/${id}/skip`,
      payload: { date: start },
    },
    { method: 'DELETE' as const, url: `/v1/customer/subscriptions/${id}/skip/${start}` },
    { method: 'POST' as const, url: `/v1/customer/subscriptions/${id}/cancel` },
  ];
  for (const operation of foreignOperations) {
    const denied = await http.inject({
      ...operation,
      headers: { authorization: `Bearer ${other}`, 'idempotency-key': uuidV7() },
    });
    expect([operation.method, operation.url, denied.statusCode]).toEqual([
      operation.method,
      operation.url,
      404,
    ]);
  }
  const afterForeignChanges = await http.inject({
    method: 'GET',
    url: `/v1/customer/subscriptions/${id}`,
    headers: { authorization: `Bearer ${customer}` },
  });
  expect(afterForeignChanges.statusCode).toBe(200);
  expect(afterForeignChanges.json()).toEqual(beforeForeignChanges.json());
  const actionHeaders = () => ({
    authorization: `Bearer ${customer}`,
    'idempotency-key': uuidV7(),
  });
  const actions = [
    { method: 'GET' as const, url: `/v1/customer/subscriptions/${id}/upcoming`, expected: 200 },
    {
      method: 'PATCH' as const,
      url: `/v1/customer/subscriptions/${id}`,
      payload: { quantity: '3' },
      expected: 200,
    },
    {
      method: 'POST' as const,
      url: `/v1/customer/subscriptions/${id}/skip`,
      payload: { date: start },
      expected: 201,
    },
    {
      method: 'DELETE' as const,
      url: `/v1/customer/subscriptions/${id}/skip/${start}`,
      expected: 200,
    },
    {
      method: 'POST' as const,
      url: `/v1/customer/subscriptions/${id}/pause`,
      payload: { from: start, to: start },
      expected: 201,
    },
    { method: 'POST' as const, url: `/v1/customer/subscriptions/${id}/resume`, expected: 201 },
    { method: 'POST' as const, url: `/v1/customer/subscriptions/${id}/cancel`, expected: 201 },
  ];
  for (const { expected, ...action } of actions) {
    const keyHeaders = actionHeaders();
    const first = await http.inject({ ...action, headers: keyHeaders });
    expect([action.method, action.url, first.statusCode]).toEqual([
      action.method,
      action.url,
      expected,
    ]);
    if (action.method !== 'GET') {
      const repeated = await http.inject({ ...action, headers: keyHeaders });
      expect([action.method, action.url, repeated.statusCode, repeated.body]).toEqual([
        action.method,
        action.url,
        expected,
        first.body,
      ]);
      if ('payload' in action && action.payload) {
        const conflicting = await http.inject({
          ...action,
          headers: keyHeaders,
          payload: {
            ...action.payload,
            ...(action.method === 'PATCH'
              ? { quantity: '4' }
              : 'date' in action.payload
                ? { date: '2099-01-01' }
                : { to: '2099-01-01' }),
          },
        });
        expect(conflicting.statusCode).toBe(409);
        expect(conflicting.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
    }
  }
  const staff = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${staff}::uuid,'WORKFORCE','p10-support','p10-support@example.invalid','support')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${staff}::uuid,'SUPPORT_AGENT')`.execute(
    world.db.db,
  );
  const adminApp = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'admin',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
    }),
    [{ name: 'test', async check() {} }],
  );
  try {
    const adminHttp = adminApp.getHttpAdapter().getInstance();
    const token = await http.inject({
      method: 'POST',
      url: '/dev/auth/token',
      payload: { pool: 'WORKFORCE', sub: 'p10-support', audience: 'admin', tokenUse: 'access' },
    });
    expect(token.statusCode).toBe(201);
    const forbidden = await adminHttp.inject({
      method: 'PUT',
      url: '/v1/admin/subscriptions/plans',
      headers: { authorization: `Bearer ${token.json().token}`, 'idempotency-key': uuidV7() },
      payload: { variantId: variant.id, active: true },
    });
    expect(forbidden.statusCode).toBe(403);
  } finally {
    await adminApp.close();
  }
});

it('serializes a cutoff-locked quantity change against generation using the original quantity', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const { SUBSCRIPTIONS } =
    await import('../../../src/modules/subscriptions/contracts/subscriptions.js');
  const { firstEditableDate } =
    await import('../../../src/modules/subscriptions/domain/schedule.js');
  const subscriptionService =
    app.get<
      import('../../../src/modules/subscriptions/contracts/subscriptions.js').SubscriptionOperations
    >(SUBSCRIPTIONS);
  const variant = await world.variant({ price: 1000n, stock: 5n }),
    plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO app_config(key,value) VALUES('subscriptionCutoffTime','"00:00"'::jsonb) ON CONFLICT(key) DO UPDATE SET value='"00:00"'::jsonb`.execute(
    world.db.db,
  );
  await sql`UPDATE wallet_accounts SET cash_balance_paise=5000 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  const actual = await Promise.all([
    worker['process']({
      id: subscription,
      user_id: world.customer,
      store_id: world.store,
      delivery_date: date,
    }),
    subscriptionService.quantity(world.customer, subscription, '2'),
  ]);
  const versions = await sql<{
    effective_from: string;
    quantity: string;
  }>`SELECT effective_from::text,quantity::text FROM subscription_schedule_versions WHERE subscription_id=${subscription}::uuid ORDER BY effective_from`.execute(
    world.db.db,
  );
  expect(versions.rows).toHaveLength(2);
  expect(versions.rows[1]!.effective_from).toBe(firstEditableDate(new Date(), '00:00'));
  expect(actual[1]).toEqual({ effectiveFrom: versions.rows[1]!.effective_from });
  const items = await sql<{
    qty: string;
  }>`SELECT i.ordered_qty::text AS qty FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.metadata->>'subscriptionId'=${subscription}`.execute(
    world.db.db,
  );
  expect(items.rows).toEqual([{ qty: '1' }]);
});

it('cancels and fully refunds a subscription when a picked quantity is short', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const { PICK_TASKS } = await import('../../../src/modules/picking/contracts/tasks.js');
  const { OrderConfirmedConsumer } =
    await import('../../../src/modules/picking/infrastructure/confirmation-consumer.js');
  const { consumeOnce } = await import('../../../src/platform/events/consume.js');
  const { envelopeOf } = await import('../../helpers/picking-fixture.js');
  const variant = await world.variant({ price: 1000n, stock: 4n });
  const plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7(),
    picker = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${picker}::uuid,'WORKFORCE',${picker},${picker + '@example.invalid'},'Picker')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${picker}::uuid,'PICKER')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${picker}::uuid,${world.store}::uuid,'PICKER')`.execute(
    world.db.db,
  );
  await sql`UPDATE wallet_accounts SET cash_balance_paise=5000 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE catalog_variants SET barcode=${variant.id} WHERE id=${variant.id}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,2,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  await worker['process']({
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: date,
  });
  const event = (
    await sql<{
      id: string;
      aggregate_id: string;
      payload: unknown;
    }>`SELECT id::text,aggregate_id::text,payload FROM outbox_events WHERE event_type='ORDER_CONFIRMED' AND aggregate_id=(SELECT order_id FROM subscription_occurrences WHERE subscription_id=${subscription}::uuid)`.execute(
      world.db.db,
    )
  ).rows[0]!;
  const consumer = new OrderConfirmedConsumer(app.get(APP_CONFIG));
  await consumeOnce(world.db.db, event.id, 'picking', (tx) =>
    consumer.handle(
      tx,
      envelopeOf({
        eventId: event.id,
        eventType: 'ORDER_CONFIRMED',
        aggregateId: event.aggregate_id,
        payload: event.payload,
      }),
    ),
  );
  const task = (
    await sql<{
      id: string;
      item: string;
      batch: string;
    }>`SELECT t.id::text,i.id::text AS item,b.id::text AS batch FROM pick_tasks t JOIN pick_items i ON i.task_id=t.id JOIN inventory_batches b ON b.variant_id=i.variant_id AND b.store_id=t.store_id WHERE t.order_id=${event.aggregate_id}::uuid LIMIT 1`.execute(
      world.db.db,
    )
  ).rows[0]!;
  const storeApp = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'store',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
    }),
    [{ name: 'test', async check() {} }],
  );
  try {
    const picking =
      storeApp.get<import('../../../src/modules/picking/contracts/tasks.js').PickTasks>(PICK_TASKS);
    await expect(picking.claim(picker, task.id, uuidV7())).rejects.toThrow(
      'PICK_TASK_NOT_AVAILABLE',
    );
    await sql`UPDATE pick_tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=${task.id}::uuid`.execute(
      world.db.db,
    );
    await picking.claim(picker, task.id, uuidV7());
    await picking.start(picker, task.id, uuidV7());
    await picking.pickItem(
      picker,
      task.id,
      task.item,
      { scannedBarcode: variant.id, quantity: '1', batchId: task.batch },
      uuidV7(),
    );
    await picking.shortItem(picker, task.id, task.item, { reason: 'OUT_OF_STOCK' }, uuidV7());
    const done = await picking.complete(picker, task.id, uuidV7());
    expect(done.status).toBe('CANCELLED');
    const { WalletEventConsumer } =
      await import('../../../src/modules/wallet/infrastructure/wallet-effects.js');
    const refundEvent = (
      await sql<{
        id: string;
        aggregate_id: string;
        payload: unknown;
      }>`SELECT id::text,aggregate_id::text,payload FROM outbox_events WHERE event_type='payments.refund.settled' AND payload->>'orderId'=${event.aggregate_id}`.execute(
        world.db.db,
      )
    ).rows[0];
    expect(refundEvent).toBeDefined();
    const wallet = storeApp.get(WalletEventConsumer);
    await consumeOnce(world.db.db, refundEvent!.id, 'wallet', (tx) =>
      wallet.handle(
        tx,
        envelopeOf({
          eventId: refundEvent!.id,
          eventType: 'payments.refund.settled',
          aggregateId: refundEvent!.aggregate_id,
          payload: refundEvent!.payload,
        }),
      ),
    );
    await consumeOnce(world.db.db, refundEvent!.id, 'wallet', (tx) =>
      wallet.handle(
        tx,
        envelopeOf({
          eventId: refundEvent!.id,
          eventType: 'payments.refund.settled',
          aggregateId: refundEvent!.aggregate_id,
          payload: refundEvent!.payload,
        }),
      ),
    );
    const result = await sql<{
      status: string;
      outcome: string;
      cash: string;
      reserved: string;
    }>`SELECT o.status,so.fulfillment_outcome AS outcome,a.cash_balance_paise::text AS cash,i.reserved::text AS reserved FROM subscription_occurrences so JOIN orders o ON o.id=so.order_id JOIN wallet_accounts a ON a.user_id=o.user_id JOIN store_inventory i ON i.store_id=o.store_id AND i.variant_id=${variant.id}::uuid WHERE so.subscription_id=${subscription}::uuid`.execute(
      world.db.db,
    );
    expect(result.rows).toEqual([
      { status: 'CANCELLED', outcome: 'SKIPPED_OOS', cash: '5000', reserved: '0' },
    ]);
  } finally {
    await storeApp.close();
  }
});

it('backs off unexpected generation failures and records one durable admin alert', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant(),
    plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const checkout = app.get<CheckoutOperations>(CHECKOUT),
    bad = {
      ...checkout,
      placeScheduled: async () => {
        throw new Error('UNEXPECTED_FAILURE');
      },
    } as CheckoutOperations;
  const worker = new SubscriptionGeneration(world.db.db, bad, app.get(APP_CONFIG));
  const due = {
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: date,
  };
  await worker['process'](due);
  await worker['process'](due);
  const result = await sql<{
    state: string;
    reason: string;
    future: boolean;
    alerts: string;
  }>`SELECT o.state,o.reason,o.retry_at>clock_timestamp() AS future,(SELECT count(*)::text FROM outbox_events WHERE aggregate_id=o.id AND event_type='subscription.generation_incomplete') AS alerts FROM subscription_occurrences o WHERE o.subscription_id=${subscription}::uuid`.execute(
    world.db.db,
  );
  expect(result.rows).toEqual([
    { state: 'PENDING', reason: 'UNEXPECTED_FAILURE', future: true, alerts: '1' },
  ]);
});

it('applies frequency, slot and address changes only after cutoff and resumes after address deletion', async () => {
  const { SUBSCRIPTIONS } =
    await import('../../../src/modules/subscriptions/contracts/subscriptions.js');
  const { ADDRESSES } = await import('../../../src/modules/addresses/contracts/tokens.js');
  const service =
    app.get<
      import('../../../src/modules/subscriptions/contracts/subscriptions.js').SubscriptionOperations
    >(SUBSCRIPTIONS);
  const addresses = app.get<{ remove(user: string, id: string): Promise<void> }>(ADDRESSES);
  const variant = await world.variant(),
    plan = uuidV7(),
    slot = uuidV7(),
    slot2 = uuidV7(),
    subscription = uuidV7(),
    newAddress = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${newAddress}::uuid,${world.customer}::uuid,'same zone','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.51,13),4326)::geography,false)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00'),(${slot2}::uuid,${world.store}::uuid,${slot2},'08:00','10:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id,address_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid,${world.address}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO app_config(key,value) VALUES('subscriptionCutoffTime','"00:00"'::jsonb) ON CONFLICT(key) DO UPDATE SET value='"00:00"'::jsonb`.execute(
    world.db.db,
  );
  const change = (await service.change(world.customer, subscription, {
    quantity: '2',
    frequencyRule: { type: 'ALTERNATE_DAYS' },
    slotId: slot2,
    addressId: newAddress,
  })) as { effectiveFrom: string };
  const versions = await sql<{
    effective_from: string;
    address_id: string;
    slot_id: string;
    quantity: string;
  }>`SELECT effective_from::text,address_id::text,slot_id::text,quantity::text FROM subscription_schedule_versions WHERE subscription_id=${subscription}::uuid ORDER BY effective_from`.execute(
    world.db.db,
  );
  expect(versions.rows).toEqual([
    { effective_from: date, address_id: world.address, slot_id: slot, quantity: '1' },
    { effective_from: change.effectiveFrom, address_id: newAddress, slot_id: slot2, quantity: '2' },
  ]);
  await addresses.remove(world.customer, world.address);
  const paused = await sql<{
    status: string;
  }>`SELECT status FROM subscriptions WHERE id=${subscription}::uuid`.execute(world.db.db);
  expect(paused.rows[0]?.status).toBe('PAUSED');
  expect(await service.resume(world.customer, subscription)).toEqual({
    effectiveFrom: change.effectiveFrom,
  });
  await expect(
    service.change(world.customer, subscription, { addressId: world.otherAddress }),
  ).rejects.toThrow('ADDRESS_NOT_SERVICEABLE');
});

it('paginates customer, calendar and admin lists and binds cursors to filters', async () => {
  const { SUBSCRIPTIONS, SUBSCRIPTION_ADMIN } =
    await import('../../../src/modules/subscriptions/contracts/subscriptions.js');
  const customer =
    app.get<
      import('../../../src/modules/subscriptions/contracts/subscriptions.js').SubscriptionOperations
    >(SUBSCRIPTIONS);
  const admin =
    app.get<
      import('../../../src/modules/subscriptions/contracts/subscriptions.js').SubscriptionAdmin
    >(SUBSCRIPTION_ADMIN);
  const first = (await customer.list(world.customer, 1)) as {
    items: unknown[];
    nextCursor: string;
  };
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBeTruthy();
  const second = (await customer.list(world.customer, 1, first.nextCursor)) as {
    items: { id: string }[];
  };
  expect(second.items).toHaveLength(1);
  await expect(customer.list(world.otherCustomer, 1, first.nextCursor)).rejects.toThrow(
    'INVALID_PAGE',
  );
  const month = new Date().toISOString().slice(0, 7);
  const calendar = (await customer.calendar(world.customer, month, 1)) as {
    items: unknown[];
    nextCursor: string;
  };
  expect(calendar.items).toHaveLength(1);
  expect(calendar.nextCursor).toBeTruthy();
  await expect(
    customer.calendar(world.customer, '2025-01', 1, calendar.nextCursor),
  ).rejects.toThrow('INVALID_PAGE');
  const plans = (await admin.plans(1)) as { items: { id: string }[]; nextCursor: string };
  expect(plans.nextCursor).toBeTruthy();
  const plans2 = (await admin.plans(1, plans.nextCursor)) as { items: { id: string }[] };
  expect(plans2.items[0]!.id).not.toBe(plans.items[0]!.id);
  const slots = (await admin.slots(world.store, 1)) as { nextCursor: string };
  expect(slots.nextCursor).toBeTruthy();
  await expect(admin.slots(world.otherStore, 1, slots.nextCursor)).rejects.toThrow('INVALID_PAGE');
});

it('pauses disabled accounts and disabled plans without starving healthy subscriptions', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant(),
    plan = uuidV7(),
    slot = uuidV7(),
    blocked = uuidV7(),
    disabledPlan = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO subscription_plans(id,variant_id,active) VALUES(${plan}::uuid,${variant.id}::uuid,false)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,next_delivery_date) VALUES(${blocked}::uuid,${world.otherCustomer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date),(${disabledPlan}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${disabledPlan}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  await sql`UPDATE users SET status='BLOCKED' WHERE id=${world.otherCustomer}::uuid`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  await worker.scan();
  await worker['process']({
    id: disabledPlan,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: date,
  });
  const rows = await sql<{
    id: string;
    status: string;
    reason: string | null;
  }>`SELECT s.id::text,s.status,o.reason FROM subscriptions s LEFT JOIN subscription_occurrences o ON o.subscription_id=s.id WHERE s.id=ANY(${[blocked, disabledPlan]}::uuid[]) ORDER BY s.id`.execute(
    world.db.db,
  );
  expect(rows.rows.find((r) => r.id === blocked)).toMatchObject({ status: 'PAUSED' });
  expect(rows.rows.find((r) => r.id === disabledPlan)).toMatchObject({
    status: 'PAUSED',
    reason: 'PLAN_DISABLED',
  });
  const alerts = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM outbox_events WHERE aggregate_id=${blocked}::uuid AND event_type='subscription.generation_incomplete'`.execute(
    world.db.db,
  );
  expect(alerts.rows[0]?.n).toBe('1');
});

it('reads the database cutoff after a competing subscription lock is released', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const { SUBSCRIPTIONS } =
    await import('../../../src/modules/subscriptions/contracts/subscriptions.js');
  const service =
    app.get<
      import('../../../src/modules/subscriptions/contracts/subscriptions.js').SubscriptionOperations
    >(SUBSCRIPTIONS);
  const variant = await world.variant({ price: 1000n, stock: 3n }),
    plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const current = (
    await sql<{
      tomorrow: string;
      cutoff: string;
      wait_ms: number;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS tomorrow,to_char((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')+interval '1 minute','HH24:MI') AS cutoff,ceil(60000-extract(milliseconds FROM clock_timestamp())+100)::int AS wait_ms`.execute(
      world.db.db,
    )
  ).rows[0]!;
  // 23:59→00:00 changes the date, so use a direct exact-boundary unit test instead at that rare rollover.
  if (current.cutoff === '00:00') return;
  await sql`UPDATE addresses SET deleted_at=NULL WHERE id=${world.address}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE wallet_accounts SET cash_balance_paise=5000 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO app_config(key,value) VALUES('subscriptionCutoffTime',${JSON.stringify(current.cutoff)}::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${current.tomorrow}::date,${current.tomorrow}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${current.tomorrow}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  let release!: () => void, locked!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
  const blocker = world.db.db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM subscriptions WHERE id=${subscription}::uuid FOR UPDATE`.execute(tx);
    locked();
    await hold;
  });
  await ready;
  const remaining = (
    await sql<{
      wait_ms: number;
    }>`SELECT ceil(60000-extract(milliseconds FROM clock_timestamp())+100)::int AS wait_ms`.execute(
      world.db.db,
    )
  ).rows[0]!.wait_ms;
  if (remaining > 5000) await new Promise((resolve) => setTimeout(resolve, remaining - 5000));
  const change = service.quantity(world.customer, subscription, '2');
  try {
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 5000)));
  } finally {
    release();
    await blocker;
  }
  const result = (await change) as { effectiveFrom: string };
  const expected = (
    await sql<{ date: string }>`SELECT (${current.tomorrow}::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  expect(result.effectiveFrom).toBe(expected);
  const generator = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  await generator['process']({
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: current.tomorrow,
  });
  const item = await sql<{
    qty: string;
  }>`SELECT i.ordered_qty::text AS qty FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.metadata->>'subscriptionId'=${subscription}`.execute(
    world.db.db,
  );
  expect(item.rows).toEqual([{ qty: '1' }]);
}, 120000);

it('fences a lost generation lease and recovers an expired claim', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant({ price: 1000n, stock: 3n }),
    plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7(),
    oldToken = uuidV7(),
    newToken = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`UPDATE addresses SET deleted_at=NULL WHERE id=${world.address}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE wallet_accounts SET cash_balance_paise=5000 WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO app_config(key,value) VALUES('subscriptionGenerationTime','"00:00"'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date,generation_claim_token,generation_claim_until) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date,${newToken}::uuid,clock_timestamp()+interval '1 minute')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG)),
    due = {
      id: subscription,
      user_id: world.customer,
      store_id: world.store,
      delivery_date: date,
      claim_token: oldToken,
    };
  await worker['process'](due);
  expect(
    (
      await sql`SELECT 1 FROM subscription_occurrences WHERE subscription_id=${subscription}::uuid`.execute(
        world.db.db,
      )
    ).rows,
  ).toHaveLength(0);
  await sql`UPDATE subscriptions SET generation_claim_until=clock_timestamp()-interval '1 second' WHERE id=${subscription}::uuid`.execute(
    world.db.db,
  );
  await worker.scan(100, world.store);
  const rows = await sql<{
    state: string;
    n: string;
  }>`SELECT state,(SELECT count(*)::text FROM orders WHERE metadata->>'subscriptionId'=${subscription}) AS n FROM subscription_occurrences WHERE subscription_id=${subscription}::uuid`.execute(
    world.db.db,
  );
  expect(rows.rows).toEqual([{ state: 'ORDERED', n: '1' }]);
});

it('claims separate store batches without overlap under concurrent workers', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant(),
    plan = uuidV7(),
    one = uuidV7(),
    two = uuidV7(),
    slot1 = uuidV7(),
    slot2 = uuidV7();
  const date = (
    await sql<{
      date: string;
    }>`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot1}::uuid,${world.store}::uuid,${slot1},'07:00','09:00'),(${slot2}::uuid,${world.otherStore}::uuid,${slot2},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${one}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date),(${two}::uuid,${world.customer}::uuid,${plan}::uuid,${world.otherStore}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${one}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot1}::uuid),(${uuidV7()}::uuid,${two}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot2}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_holidays(store_id,holiday_date) VALUES(${world.store}::uuid,${date}::date),(${world.otherStore}::uuid,${date}::date) ON CONFLICT DO NOTHING`.execute(
    world.db.db,
  );
  const w1 = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG)),
    w2 = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  const [n1, n2] = await Promise.all([w1.scan(100, world.store), w2.scan(100, world.otherStore)]);
  expect(n1).toBeGreaterThan(0);
  expect(n2).toBeGreaterThan(0);
  const result = await sql<{
    subscription_id: string;
    n: string;
    state: string;
  }>`SELECT subscription_id::text,count(*)::text AS n,min(state) AS state FROM subscription_occurrences WHERE subscription_id=ANY(${[one, two]}::uuid[]) AND delivery_date=${date}::date GROUP BY subscription_id ORDER BY subscription_id`.execute(
    world.db.db,
  );
  expect(result.rows).toHaveLength(2);
  expect(result.rows.every((r) => r.n === '1' && r.state === 'SKIPPED')).toBe(true);
});

it('advances across a future schedule version after recovering an overdue occurrence', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant(),
    plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const dates = (
    await sql<{
      yesterday: string;
      tomorrow: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-1)::text AS yesterday,((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS tomorrow`.execute(
      world.db.db,
    )
  ).rows[0]!;
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,next_delivery_date) VALUES(${subscription}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${dates.yesterday}::date,${dates.yesterday}::date)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${subscription}::uuid,${dates.yesterday}::date,1,'{"type":"EVERY_N_DAYS","n":30}'::jsonb,${slot}::uuid),(${uuidV7()}::uuid,${subscription}::uuid,${dates.tomorrow}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  await worker['process']({
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: dates.yesterday,
  });
  const result = await sql<{
    next: string;
  }>`SELECT next_delivery_date::text AS next FROM subscriptions WHERE id=${subscription}::uuid`.execute(
    world.db.db,
  );
  expect(result.rows[0]?.next).toBe(dates.tomorrow);
});

it('skips a locked due row and later reclaims it without duplicate occurrences', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const { APP_CONFIG } = await import('../../../src/modules/app-config/contracts/config.js');
  const variant = await world.variant(),
    plan = uuidV7(),
    slot = uuidV7(),
    ids = [uuidV7(), uuidV7()].sort();
  const date = (
    await sql<{
      date: string;
    }>`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date`.execute(
      world.db.db,
    )
  ).rows[0]!.date;
  await sql`INSERT INTO app_config(key,value) VALUES('subscriptionExtendOnHoliday','false'::jsonb) ON CONFLICT(key) DO UPDATE SET value='false'::jsonb`.execute(
    world.db.db,
  );
  await sql`UPDATE subscriptions SET status='PAUSED' WHERE store_id=${world.store}::uuid AND status='ACTIVE'`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'07:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_holidays(store_id,holiday_date) VALUES(${world.store}::uuid,${date}::date) ON CONFLICT DO NOTHING`.execute(
    world.db.db,
  );
  for (const id of ids) {
    await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) VALUES(${id}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date)`.execute(
      world.db.db,
    );
    await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${id}::uuid,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
      world.db.db,
    );
  }
  let release!: () => void, signal!: () => void;
  const blocked = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      signal = r;
    });
  const holder = world.db.db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM subscriptions WHERE id=${ids[0]}::uuid FOR UPDATE`.execute(tx);
    signal();
    await blocked;
  });
  await ready;
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  try {
    expect(await worker.scan(1, world.store)).toBe(1);
    const first = await sql<{
      id: string;
    }>`SELECT subscription_id::text AS id FROM subscription_occurrences WHERE subscription_id=ANY(${ids}::uuid[])`.execute(
      world.db.db,
    );
    expect(first.rows).toEqual([{ id: ids[1] }]);
  } finally {
    release();
    await holder;
  }
  expect(await worker.scan(1, world.store)).toBe(1);
  await worker.scan(1, world.store);
  const results = await sql<{
    id: string;
    n: string;
  }>`SELECT subscription_id::text AS id,count(*)::text AS n FROM subscription_occurrences WHERE subscription_id=ANY(${ids}::uuid[]) GROUP BY subscription_id ORDER BY subscription_id`.execute(
    world.db.db,
  );
  expect(results.rows).toEqual(ids.map((id) => ({ id, n: '1' })));
});
