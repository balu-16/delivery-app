import { setTimeout as delay } from 'node:timers/promises';
import { jest } from '@jest/globals';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
import { createAwsTestQueues, trackAwsTestRateKeys } from '../../helpers/aws-test-queues.js';
import { PLATFORM_REDIS } from '../../../src/platform/contracts/runtime.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let carts: CartService;
let checkout: CheckoutOperations;
let otherAddress: string;
let token: string;
let testQueues: Awaited<ReturnType<typeof createAwsTestQueues>> | undefined;
let cleanRateKeys: (() => Promise<void>) | undefined;
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
    otherAddress = uuidV7();
    await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) SELECT ${otherAddress}::uuid,${world.otherCustomer}::uuid,line1,pincode,contact_name,contact_phone,point,true FROM addresses WHERE id=${world.address}::uuid`.execute(
      world.db.db,
    );
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
    carts = app.get<CartService>(CART_SERVICE);
    checkout = app.get<CheckoutOperations>(CHECKOUT);
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
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
afterAll(
  async () => {
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
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
beforeEach(async () => {
  for (const user of [world.customer, world.otherCustomer]) {
    const cart = await carts.get(user);
    if (cart) await carts.deleteCart(user, { expectedVersion: cart.version });
  }
});
async function quote(user: string, addressId: string, variantId: string) {
  const cart = await carts.getOrCreateActiveCart(user, addressId);
  await carts.putItem(user, variantId, '1', { expectedVersion: cart.version });
  return checkout.quote(user, { addressId });
}
it('two customer checkouts contend for the last unit and only one commits', async () => {
  const variant = await world.variant({ stock: 1n });
  const first = await quote(world.customer, world.address, variant.id);
  const second = await quote(world.otherCustomer, otherAddress, variant.id);
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const blocker = world.db.db.transaction().execute(async (tx) => {
    await sql`SELECT 1 FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid FOR UPDATE`.execute(
      tx,
    );
    ready();
    await gate;
  });
  await locked;
  const place = (user: string, q: typeof first) =>
    checkout.place(user, {
      quoteId: q.quote.quoteId,
      intentId: q.intentId,
      method: 'GATEWAY',
      idempotencyOperationId: uuidV7(),
    });
  const attempts = Promise.allSettled([
    place(world.customer, first),
    place(world.otherCustomer, second),
  ]);
  try {
    const deadline = Date.now() + (process.env.AWS_P13_INTEGRATION === 'yes' ? 20000 : 5000);
    let waiting = false;
    while (Date.now() < deadline && !waiting) {
      waiting =
        Number(
          (
            await sql<{
              n: string;
            }>`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`.execute(
              world.db.db,
            )
          ).rows[0]?.n ?? 0,
        ) >= 2;
      if (!waiting) await delay(20);
    }
    expect(waiting).toBe(true);
  } finally {
    release();
    await blocker;
  }
  const results = await attempts;
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((r) => r.status === 'rejected');
  expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain(
    'INVENTORY_INSUFFICIENT',
  );
  const state = await sql<{
    orders: string;
    reserved: string;
  }>`SELECT (SELECT count(*)::text FROM orders WHERE metadata->>'intentId' IN (${first.intentId},${second.intentId})) AS orders,(SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved`.execute(
    world.db.db,
  );
  expect(state.rows[0]).toEqual({ orders: '1', reserved: '1' });
});
it('validates checkout quote input over HTTP with an existing cart and address', async () => {
  const variant = await world.variant({ stock: 5n });
  const cart = await carts.getOrCreateActiveCart(world.customer, world.address);
  await carts.putItem(world.customer, variant.id, '1', { expectedVersion: cart.version });
  const http = app.getHttpAdapter().getInstance();
  const headers = { authorization: `Bearer ${token}` };
  const invalid = await http.inject({
    method: 'POST',
    url: '/v1/customer/checkout/quote',
    headers,
    payload: { addressId: world.address, unexpected: 'canary' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.body).not.toContain('canary');
  const valid = await http.inject({
    method: 'POST',
    url: '/v1/customer/checkout/quote',
    headers,
    payload: { addressId: world.address },
  });
  expect(valid.statusCode).toBe(200);
  expect(valid.json().quote.quoteId).toBeTruthy();
});
it('same-key concurrent HTTP placement rejects an in-progress request and replays the committed order', async () => {
  const variant = await world.variant({ stock: 5n });
  const q = await quote(world.customer, world.address, variant.id);
  const key = uuidV7();
  const payload = { quoteId: q.quote.quoteId, intentId: q.intentId, method: 'GATEWAY' };
  const http = app.getHttpAdapter().getInstance();
  const send = (body = payload) =>
    http.inject({
      method: 'POST',
      url: '/v1/customer/checkout/place',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      payload: body,
    });
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const blocker = world.db.db.transaction().execute(async (tx) => {
    await sql`SELECT id FROM users WHERE id=${world.customer}::uuid FOR UPDATE`.execute(tx);
    ready();
    await gate;
  });
  await locked;
  const first = send();
  try {
    const deadline = Date.now() + (process.env.AWS_P13_INTEGRATION === 'yes' ? 20000 : 5000);
    let claimed = false;
    while (Date.now() < deadline && !claimed) {
      claimed =
        (
          await sql`SELECT 1 FROM idempotency_keys WHERE key=${key} AND state='PROCESSING'`.execute(
            world.db.db,
          )
        ).rows.length === 1;
      if (!claimed) await delay(20);
    }
    expect(claimed).toBe(true);
    const concurrent = await send();
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json().code).toBe('REQUEST_IN_PROGRESS');
  } finally {
    release();
    await blocker;
  }
  const original = await first;
  expect(original.statusCode).toBe(201);
  // A client can lose the committed response and retry with the original key.
  const replay = await send();
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(original.json());
  const changed = await send({ ...payload, intentId: uuidV7() });
  expect(changed.statusCode).toBe(409);
  expect(changed.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  const state = await sql<{
    orders: string;
    attempts: string;
    reserved: string;
  }>`SELECT (SELECT count(*)::text FROM orders WHERE metadata->>'intentId'=${q.intentId}) AS orders,(SELECT count(*)::text FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE metadata->>'intentId'=${q.intentId})) AS attempts,(SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved`.execute(
    world.db.db,
  );
  expect(state.rows[0]).toEqual({ orders: '1', attempts: '1', reserved: '1' });
});
