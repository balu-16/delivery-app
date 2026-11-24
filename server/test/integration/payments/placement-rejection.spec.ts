import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let server: FastifyInstance;
let carts: CartService;
let checkout: CheckoutOperations;
let token: string;

beforeAll(async () => {
  world = await createP5World();
  await sql`INSERT INTO feature_flags(key,enabled) VALUES ('cod_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(world.db.db);
  await sql`UPDATE stores SET accepts_cod=true WHERE id=${world.store}::uuid`.execute(world.db.db);
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
    REDIS_URL: world.services.redisUrl,
    ...(world.services.databaseIamUrl
      ? { DATABASE_AUTH: 'iam', AWS_REGION: process.env.AWS_REGION }
      : {}),
  });
  app = await createApplication(env, [{ name: 'test', async check() {} }]);
  server = app.getHttpAdapter().getInstance();
  carts = app.get(CART_SERVICE);
  checkout = app.get(CHECKOUT);
  token = await new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db).issue(
    'CUSTOMER',
    'p5-customer',
    'customer',
    'access',
  );
}, 180000);

afterAll(async () => {
  await app?.close();
  if (world) await closeP5World(world);
}, 180000);

beforeEach(async () => {
  const cart = await carts.get(world.customer);
  if (cart) await carts.deleteCart(world.customer, { expectedVersion: cart.version });
});

async function quotedCart() {
  const variant = await world.variant({ stock: 10n });
  const cart = await carts.getOrCreateActiveCart(world.customer, world.address);
  await carts.putItem(world.customer, variant.id, '1', { expectedVersion: cart.version });
  const quoted = await checkout.quote(world.customer, { addressId: world.address });
  return { variant, quoted };
}

it('records a proven rejection and replays its code without creating an order', async () => {
  const { variant, quoted } = await quotedCart();
  await world.reprice(world.store, variant.id, variant.price + 100n);
  const key = uuidV7();
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': key };
  const payload = { quoteId: quoted.quote.quoteId, intentId: quoted.intentId, method: 'COD' };
  const first = await server.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers,
    payload,
  });
  expect(first.statusCode).toBe(409);
  expect(first.json<{ code: string }>().code).toBe('PRICE_CHANGED');
  const status = await server.inject({
    method: 'GET',
    url: '/v1/customer/checkout/placement-status',
    headers,
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toEqual({ state: 'REJECTED', code: 'PRICE_CHANGED' });
  // Same key and body replays the recorded rejection; nothing is placed.
  const retry = await server.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers,
    payload,
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json<{ code: string }>().code).toBe('PRICE_CHANGED');
  const rows = await sql<{ orders: string }>`SELECT count(*)::text AS orders FROM orders
    WHERE metadata->>'intentId'=${quoted.intentId}`.execute(world.db.db);
  expect(rows.rows[0]).toEqual({ orders: '0' });
}, 180000);

it('recovers the committed order when another key consumed the intent', async () => {
  const { quoted } = await quotedCart();
  const firstKey = uuidV7();
  const payload = { quoteId: quoted.quote.quoteId, intentId: quoted.intentId, method: 'COD' };
  const placed = await server.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': firstKey },
    payload,
  });
  expect(placed.statusCode).toBe(201);
  const orderId = placed.json<{ order: { orderId: string } }>().order.orderId;
  // A different key for the same consumed intent recovers the order read-only.
  const secondKey = uuidV7();
  const retry = await server.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': secondKey },
    payload,
  });
  expect(retry.statusCode).toBe(201);
  expect(retry.json<{ order: { orderId: string } }>().order.orderId).toBe(orderId);
  // No rejection is recorded when the order exists elsewhere.
  const status = await server.inject({
    method: 'GET',
    url: '/v1/customer/checkout/placement-status',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': secondKey },
  });
  expect(status.json<{ state: string }>().state).not.toBe('REJECTED');
  const rows = await sql<{ orders: string }>`SELECT count(*)::text AS orders FROM orders
    WHERE metadata->>'intentId'=${quoted.intentId}`.execute(world.db.db);
  expect(rows.rows[0]).toEqual({ orders: '1' });
}, 180000);

it('keeps reporting REJECTED after the cached response is pruned', async () => {
  const { variant, quoted } = await quotedCart();
  await world.reprice(world.store, variant.id, variant.price + 100n);
  const key = uuidV7();
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': key };
  const payload = { quoteId: quoted.quote.quoteId, intentId: quoted.intentId, method: 'COD' };
  const first = await server.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers,
    payload,
  });
  expect(first.json<{ code: string }>().code).toBe('PRICE_CHANGED');
  await sql`UPDATE idempotency_keys SET response_status=NULL, response_body=NULL, response_expires_at=NULL
    WHERE actor=${world.customer} AND audience='customer' AND method='POST'
    AND resource='/v1/customer/checkout/place' AND key=${key}`.execute(world.db.db);
  const status = await server.inject({
    method: 'GET',
    url: '/v1/customer/checkout/placement-status',
    headers,
  });
  expect(status.json()).toEqual({ state: 'REJECTED', code: 'PRICE_CHANGED' });
  const retry = await server.inject({
    method: 'POST',
    url: '/v1/customer/checkout/place',
    headers,
    payload,
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json<{ code: string }>().code).toBe('PRICE_CHANGED');
}, 180000);
