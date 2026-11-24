import { sql } from 'kysely';
import { jest } from '@jest/globals';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { APP_CONFIG } from '../../../src/modules/app-config/contracts/config.js';
import { createP5World, closeP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(300000);
beforeAll(
  async () => {
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
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
afterAll(async () => {
  await app?.close();
  await closeP5World(world);
});
async function token(sub: string) {
  const http = app.getHttpAdapter().getInstance();
  const response = await http.inject({
    method: 'POST',
    url: '/dev/auth/token',
    payload: { pool: 'CUSTOMER', sub, audience: 'customer', tokenUse: 'access' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().token as string;
}

it('returns compat reads and retired writes over HTTP', async () => {
  const customer = await token('p5-customer');
  const variant = await world.variant();
  const headers = { authorization: `Bearer ${customer}`, 'idempotency-key': uuidV7() };
  const list = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'GET',
      url: '/v1/customer/subscriptions',
      headers: { authorization: `Bearer ${customer}` },
    });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual({ items: [], nextCursor: null });
  const options = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'GET',
      url: `/v1/customer/subscriptions/options?addressId=${world.address}&variantId=${variant.id}`,
      headers: { authorization: `Bearer ${customer}` },
    });
  expect(options.statusCode).toBe(200);
  expect(options.json()).toMatchObject({ enabled: false, eligible: false, slots: [] });
  const payload = {
    variantId: variant.id,
    quantity: '1',
    frequencyRule: { type: 'DAILY' },
    startDate: '2040-05-01',
    slotId: uuidV7(),
    addressId: world.address,
  };
  for (const operation of [
    { method: 'POST', url: '/v1/customer/subscriptions', payload },
    {
      method: 'PATCH',
      url: `/v1/customer/subscriptions/${uuidV7()}`,
      payload: { quantity: '2' },
    },
    {
      method: 'POST',
      url: `/v1/customer/subscriptions/${uuidV7()}/pause`,
      payload: { from: '2040-05-02', to: '2040-05-03' },
    },
    { method: 'POST', url: `/v1/customer/subscriptions/${uuidV7()}/resume` },
    {
      method: 'POST',
      url: `/v1/customer/subscriptions/${uuidV7()}/skip`,
      payload: { date: '2040-05-02' },
    },
  ]) {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        ...operation,
        headers,
        payload: operation.payload,
      });
    expect([operation.method, response.statusCode, response.json().code]).toEqual([
      operation.method,
      410,
      'SUBSCRIPTIONS_RETIRED',
    ]);
  }
  const zero = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM subscriptions WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  expect(zero.rows[0]?.n).toBe('0');
});

it('keeps cancel available for historical agreements with audit', async () => {
  const customer = await token('p5-customer');
  const variant = await world.variant();
  const plan = uuidV7();
  await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
    world.db.db,
  );
  const sub = uuidV7(),
    slot = uuidV7();
  await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'06:00','09:00')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,status) VALUES(${sub}::uuid,${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,current_date,'ACTIVE')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) VALUES(${uuidV7()}::uuid,${sub}::uuid,current_date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid)`.execute(
    world.db.db,
  );
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/v1/customer/subscriptions/${sub}/cancel`,
      headers: { authorization: `Bearer ${customer}`, 'idempotency-key': uuidV7() },
    });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ status: 'CANCELLED' });
  const audit = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM audit_log WHERE subject_type='subscription' AND subject_id=${sub} AND action='SUBSCRIPTION_CANCELLED'`.execute(
    world.db.db,
  );
  expect(audit.rows[0]?.n).toBe('1');
});

it('creates zero recurring orders or credits after cutover', async () => {
  const { SubscriptionGeneration } =
    await import('../../../src/modules/subscriptions/infrastructure/generation.js');
  const variant = await world.variant({ price: 1000n, stock: 4n });
  const plan = uuidV7(),
    slot = uuidV7(),
    subscription = uuidV7();
  const today = (
    await sql<{
      date: string;
    }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
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
  const before = await sql<{
    cash: string;
  }>`SELECT cash_balance_paise::text AS cash FROM wallet_accounts WHERE user_id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  const worker = new SubscriptionGeneration(world.db.db, app.get(CHECKOUT), app.get(APP_CONFIG));
  expect(await worker.scanStores(100)).toBe(0);
  await worker.forecast(100);
  await worker['process']({
    id: subscription,
    user_id: world.customer,
    store_id: world.store,
    delivery_date: today,
  });
  const effect = await sql<{
    state: string;
    reason: string;
    orders: string;
    debits: string;
    cash: string;
    alerts: string;
  }>`SELECT o.state,o.reason,(SELECT count(*)::text FROM orders WHERE metadata->>'subscriptionId'=${subscription}) AS orders,(SELECT count(*)::text FROM wallet_ledger l JOIN orders x ON l.ref_id=x.id::text WHERE x.metadata->>'subscriptionId'=${subscription} AND l.reason='ORDER_PAYMENT') AS debits,(SELECT cash_balance_paise::text FROM wallet_accounts WHERE user_id=${world.customer}::uuid) AS cash,(SELECT count(*)::text FROM outbox_events WHERE payload->>'subscriptionId'=${subscription} AND event_type IN ('subscription.low_balance','subscription.price_increase')) AS alerts FROM subscription_occurrences o WHERE subscription_id=${subscription}::uuid AND delivery_date=${today}::date`.execute(
    world.db.db,
  );
  expect(effect.rows).toEqual([
    {
      state: 'SKIPPED',
      reason: 'SUBSCRIPTIONS_RETIRED',
      orders: '0',
      debits: '0',
      cash: before.rows[0]!.cash,
      alerts: '0',
    },
  ]);
  const audit = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM audit_log WHERE action='SUBSCRIPTIONS_RETIRED' AND subject_id=${subscription}`.execute(
    world.db.db,
  );
  expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(1);
});

it('keeps already-placed scheduled orders on the normal lifecycle', async () => {
  const checkout = app.get<CheckoutOperations>(CHECKOUT);
  const variant = await world.variant({ price: 10000n, stock: 3n });
  const start = new Date(Date.now() + 86400000),
    end = new Date(start.getTime() + 3600000);
  const subscription = uuidV7();
  const placed = await world.db.db.transaction().execute((tx) =>
    checkout.placeScheduled(
      {
        userId: world.customer,
        subscriptionId: subscription,
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
  }>`SELECT status,source FROM orders WHERE id=${placed.orderId}::uuid`.execute(world.db.db);
  expect(rows.rows[0]).toEqual({ status: 'CONFIRMED', source: 'SUBSCRIPTION' });
});
