/** Plan checkout smoke over HTTP on an isolated AWS fixture (or containers).
 * Favorites, cart add/undo, admin-configured fee estimates, COD checkout,
 * replay-to-single-order and placement-status. The fixture database is
 * disposable; assertions below are the pre-cleanup record verification. */
import { jest } from '@jest/globals';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { PLATFORM_REDIS } from '../../../src/platform/contracts/runtime.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
import { createAwsTestQueues, trackAwsTestRateKeys } from '../../helpers/aws-test-queues.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let token: string;
let adminToken: string;
let testQueues: Awaited<ReturnType<typeof createAwsTestQueues>> | undefined;
let cleanRateKeys: (() => Promise<void>) | undefined;
if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(300000);

beforeAll(async () => {
  world = await createP5World();
  if (process.env.AWS_P13_INTEGRATION === 'yes') testQueues = await createAwsTestQueues();
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      ...(testQueues
        ? {
            CACHE_AUTH: 'elasticache-iam',
            CACHE_URL: process.env.CACHE_URL,
            CACHE_IAM_NAME: process.env.CACHE_IAM_NAME,
            CACHE_IAM_USER: process.env.CACHE_IAM_USER,
            AWS_REGION: process.env.AWS_REGION,
            AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID,
            QUEUE_TRANSPORT: 'sqs',
            SQS_QUEUE_PREFIX: testQueues.prefix,
          }
        : {}),
    }),
  );
  if (testQueues) cleanRateKeys = trackAwsTestRateKeys(app.get<Redis>(PLATFORM_REDIS));
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/dev/auth/token',
      payload: { pool: 'CUSTOMER', sub: 'p5-customer', audience: 'customer', tokenUse: 'access' },
    });
  expect(response.statusCode).toBe(201);
  token = response.json().token as string;
  const adminResponse = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/dev/auth/token',
      payload: { pool: 'WORKFORCE', sub: 'p5-admin', audience: 'admin', tokenUse: 'access' },
    });
  expect(adminResponse.statusCode).toBe(201);
  adminToken = adminResponse.json().token as string;
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('cod_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(world.db.db);
  await sql`UPDATE stores SET accepts_cod=true WHERE id=${world.store}::uuid`.execute(world.db.db);
}, 300000);

afterAll(async () => {
  try {
    await cleanRateKeys?.();
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await testQueues?.close();
      } finally {
        if (world) await closeP5World(world);
      }
    }
  }
}, 300000);

const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

it('adds, lists and removes a favorite over HTTP', async () => {
  const variant = await world.variant({ stock: 10n });
  const product = (
    await sql<{
      product_id: string;
    }>`SELECT product_id FROM catalog_variants WHERE id=${variant.id}::uuid`.execute(world.db.db)
  ).rows[0]!.product_id;
  const http = app.getHttpAdapter().getInstance();
  const put = await http.inject({
    method: 'PUT',
    url: `/v1/customer/favorites/${product}`,
    headers: headers(),
  });
  expect(put.statusCode).toBe(204);
  const list = await http.inject({
    method: 'GET',
    url: '/v1/customer/favorites',
    headers: headers(),
  });
  expect(list.statusCode).toBe(200);
  expect(list.json().items).toContain(product);
  const remove = await http.inject({
    method: 'DELETE',
    url: `/v1/customer/favorites/${product}`,
    headers: headers(),
  });
  expect(remove.statusCode).toBe(204);
  const relist = await http.inject({
    method: 'GET',
    url: '/v1/customer/favorites',
    headers: headers(),
  });
  expect(relist.json().items).not.toContain(product);
}, 180000);

it('adds to the cart and undoes over HTTP with version bumps', async () => {
  const variant = await world.variant({ stock: 10n });
  const http = app.getHttpAdapter().getInstance();
  const put = (quantity: string, version: number) =>
    http.inject({
      method: 'PUT',
      url: `/v1/customer/cart/items/${variant.id}`,
      headers: headers({ 'idempotency-key': uuidV7() }),
      payload: { quantity, version },
    });
  const first = await put('1', 1);
  expect(first.statusCode).toBe(200);
  expect(first.json().cart.version).toBe(2);
  const second = await put('2', 2);
  expect(second.json().cart.version).toBe(3);
  expect(second.json().cart.lines[0]).toMatchObject({ variantId: variant.id, quantity: '2' });
  const undo = await put('1', 3);
  expect(undo.json().cart.version).toBe(4);
  expect(undo.json().cart.lines[0]).toMatchObject({ variantId: variant.id, quantity: '1' });
  const cart = await http.inject({ method: 'GET', url: '/v1/customer/cart', headers: headers() });
  expect(cart.json().lines[0]).toMatchObject({ variantId: variant.id, quantity: '1' });
}, 180000);

it('serves admin-configured fee bands through delivery-settings', async () => {
  const fees: Record<string, unknown> = {
    deliveryFeeSlabs: [
      { maxOrderValuePaise: '20000', feePaise: '4000' },
      { maxOrderValuePaise: null, feePaise: '2000' },
    ],
    freeDeliveryThresholdPaise: '59900',
    handlingFeePaise: '500',
    smallCartThresholdPaise: '19900',
    smallCartFeePaise: '1500',
    surgeFeePaise: '2500',
  };
  for (const [key, value] of Object.entries(fees))
    await sql`INSERT INTO app_config(key,value) VALUES(${key},${JSON.stringify(value)}::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=${JSON.stringify(value)}::jsonb`.execute(world.db.db);
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('surge_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(world.db.db);
  const http = app.getHttpAdapter().getInstance();
  const settings = await http.inject({
    method: 'GET',
    url: '/v1/customer/delivery-settings',
    headers: headers(),
  });
  expect(settings.statusCode).toBe(200);
  const estimate = settings.json().feeEstimate;
  expect(typeof estimate.revision).toBe('string');
  expect(
    estimate.bands.map((b: { upToSubtotalPaise: string | null }) => b.upToSubtotalPaise),
  ).toEqual(['19900', '20000', '59900', null]);
  expect(estimate.bands[0]).toMatchObject({
    deliveryPaise: '4000',
    handlingPaise: '500',
    smallCartPaise: '0',
    surgePaise: '2500',
  });
  expect(estimate.bands[2].deliveryPaise).toBe('0');
  // An admin edit through the real API is served on the next read.
  const edit = await http.inject({
    method: 'POST',
    url: '/v1/admin/config/surgeFeePaise',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { value: '3000' },
  });
  expect(edit.statusCode).toBe(201);
  const refreshed = await http.inject({
    method: 'GET',
    url: '/v1/customer/delivery-settings',
    headers: headers(),
  });
  expect(refreshed.json().feeEstimate.bands[0].surgePaise).toBe('3000');
}, 180000);

it('places one COD order, replays to the same order and reports status', async () => {
  const variant = await world.variant({ stock: 10n });
  const http = app.getHttpAdapter().getInstance();
  const key = () => headers({ 'idempotency-key': uuidV7() });
  const before = await http.inject({ method: 'GET', url: '/v1/customer/cart', headers: headers() });
  if (before.statusCode === 200 && (before.json().lines?.length ?? 0) > 0) {
    const cleared = await http.inject({
      method: 'DELETE',
      url: `/v1/customer/cart?version=${before.json().version}`,
      headers: key(),
    });
    expect([200, 204]).toContain(cleared.statusCode);
  }
  const added = await http.inject({
    method: 'PUT',
    url: `/v1/customer/cart/items/${variant.id}`,
    headers: key(),
    payload: { quantity: '2', version: 1 },
  });
  expect(added.statusCode).toBe(200);
  const quoted = await http.inject({
    method: 'POST',
    url: '/v1/customer/checkout/quote',
    headers: headers(),
    payload: { addressId: world.address },
  });
  expect(quoted.statusCode).toBe(200);
  expect(quoted.json().quote.quoteId).toBeTruthy();
  expect(quoted.json().cart).toBeTruthy();
  const payload = {
    quoteId: quoted.json().quote.quoteId,
    intentId: quoted.json().intentId,
    method: 'COD',
  };
  const placeKey = uuidV7();
  const place = await http.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers: headers({ 'idempotency-key': placeKey }),
    payload,
  });
  expect(place.statusCode).toBe(201);
  const orderId = (place.json().order.orderId ?? place.json().order.id) as string;
  expect(orderId).toBeTruthy();
  const replay = await http.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers: headers({ 'idempotency-key': placeKey }),
    payload,
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(place.json());
  const status = await http.inject({
    method: 'GET',
    url: '/v1/customer/checkout/placement-status',
    headers: headers({ 'idempotency-key': placeKey }),
  });
  expect(status.statusCode).toBe(200);
  expect(status.json().state).toBe('ORDER_FOUND');
  expect(status.json().order.orderId).toBe(orderId);
  const state = await sql<{
    orders: string;
    number: string;
    status: string;
    payment: string;
    lines: string;
  }>`SELECT (SELECT count(*)::text FROM orders WHERE metadata->>'intentId'=${payload.intentId}) AS orders,
    o.order_number AS number, o.status AS status, o.payment_status AS payment,
    (SELECT count(*)::text FROM order_items WHERE order_id=o.id) AS lines
    FROM orders o WHERE o.id=${orderId}::uuid`.execute(world.db.db);
  expect(state.rows[0]?.orders).toBe('1');
  console.log(
    `SMOKE_ORDER number=${state.rows[0]?.number} status=${state.rows[0]?.status} payment=${state.rows[0]?.payment} lines=${state.rows[0]?.lines}`,
  );
}, 180000);
