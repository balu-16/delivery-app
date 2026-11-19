import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import { CART_INTENTS, type CartIntents } from '../../../src/modules/cart/contracts/intent.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { PostgresCouponAdministration } from '../../../src/modules/coupons/infrastructure/postgres-coupon-admin.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let server: FastifyInstance;
let carts: CartService;
let checkout: CheckoutOperations;
let intents: CartIntents;
let token: string;

beforeAll(
  async () => {
    world = await createP5World();
    await sql`INSERT INTO feature_flags(key,enabled) VALUES ('cod_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(world.db.db);
    await sql`UPDATE stores SET accepts_cod=true WHERE id=${world.store}::uuid`.execute(
      world.db.db,
    );
    const aws = Boolean(world.services.databaseIamUrl);
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      DATABASE_POOL_MAX: '1',
      DB_ACQUIRE_TIMEOUT_MS: aws ? '30000' : '3000',
      RATE_LIMIT_DEFAULT_PER_MIN: '10000',
      RATE_LIMIT_AUTH_PER_MIN: '10000',
      ...(aws ? { DATABASE_AUTH: 'iam', AWS_REGION: process.env.AWS_REGION } : {}),
    });
    app = await createApplication(env, [{ name: 'test', async check() {} }]);
    server = app.getHttpAdapter().getInstance();
    carts = app.get(CART_SERVICE);
    checkout = app.get(CHECKOUT);
    intents = app.get(CART_INTENTS);
    token = await new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db).issue(
      'CUSTOMER',
      'p5-customer',
      'customer',
      'access',
    );
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);

afterAll(
  async () => {
    await app?.close();
    if (world) await closeP5World(world);
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);

beforeEach(async () => {
  const cart = await carts.get(world.customer);
  if (cart) await carts.deleteCart(world.customer, { expectedVersion: cart.version });
});

it('performs idempotent item and coupon writes with a single database connection', async () => {
  const administration = new PostgresCouponAdministration(
    world.db.db,
    new DatabaseIdentityAccess(world.db.db),
  );
  await administration.create(world.admin, {
    code: 'POOL-ONE',
    kind: 'PERCENT',
    valuePaise: '500',
    maxCapPaise: null,
    minOrderPaise: '0',
    perUserLimit: null,
    globalLimit: null,
    validFrom: null,
    validTo: null,
    storeId: null,
    categoryId: null,
    productId: null,
    excludedVariantIds: [],
    stackable: false,
    firstOrderOnly: false,
  });
  const variant = await world.variant();
  const key = uuidV7();
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': key };
  const add = () =>
    server.inject({
      method: 'PUT',
      url: `/v1/customer/cart/items/${variant.id}`,
      headers,
      payload: { quantity: '1', version: 1, addressId: world.address },
    });
  const first = await add();
  expect(first.statusCode).toBe(200);
  const initial = first.json<{ cart: { cartId: string; version: number } }>().cart;
  const replay = await add();
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(first.json());
  const apply = await server.inject({
    method: 'POST',
    url: '/v1/customer/cart/coupon',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': uuidV7() },
    payload: { code: 'POOL-ONE', version: initial.version },
  });
  expect(apply.statusCode).toBe(200);
  expect(apply.json<{ couponCode: string }>().couponCode).toBe('POOL-ONE');
}, 180000);

it('clears only the confirmed cart version and leaves later edits on replay', async () => {
  const first = await world.variant({ stock: 10n });
  const second = await world.variant({ stock: 10n });
  const initial = await carts.getOrCreateActiveCart(world.customer, world.address);
  await carts.putItem(world.customer, first.id, '1', { expectedVersion: initial.version });
  const quote = await checkout.quote(world.customer, { addressId: world.address });
  const input = {
    quoteId: quote.quote.quoteId,
    intentId: quote.intentId,
    method: 'COD' as const,
    idempotencyOperationId: uuidV7(),
  };
  const placed = await checkout.place(world.customer, input);
  expect(placed.confirmation).toBe('CONFIRMED');
  const cleared = await carts.get(world.customer);
  expect(cleared).toMatchObject({
    cartId: quote.quote.cartId,
    version: quote.quote.cartVersion + 1,
    couponCode: null,
    lines: [],
  });
  const history = await sql<{ quotes: string; intents: string }>`SELECT
    (SELECT count(*)::text FROM quote_snapshots WHERE id=${quote.quote.quoteId}::uuid) AS quotes,
    (SELECT count(*)::text FROM checkout_intents WHERE id=${quote.intentId}::uuid AND state='CONSUMED') AS intents`.execute(
    world.db.db,
  );
  expect(history.rows[0]).toEqual({ quotes: '1', intents: '1' });
  const next = await carts.putItem(world.customer, second.id, '1', {
    expectedVersion: cleared!.version,
  });
  const replay = await checkout.place(world.customer, input);
  expect(replay.order.orderId).toBe(placed.order.orderId);
  expect(await carts.get(world.customer)).toMatchObject({
    version: next.cart.version,
    lines: [{ variantId: second.id, quantity: '1' }],
  });
  await expect(
    world.db.db
      .transaction()
      .execute((tx) =>
        intents.completePurchase(world.customer, quote.quote.cartId, quote.quote.cartVersion, tx),
      ),
  ).rejects.toThrow('CONCURRENT_MODIFICATION');
  expect((await carts.get(world.customer))?.lines).toHaveLength(1);
}, 180000);

it('does not clear a cart for an order awaiting gateway payment', async () => {
  await sql`INSERT INTO feature_flags(key,enabled) VALUES ('online_payments_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(world.db.db);
  try {
    const variant = await world.variant({ stock: 10n });
    const cart = await carts.getOrCreateActiveCart(world.customer, world.address);
    await carts.putItem(world.customer, variant.id, '1', { expectedVersion: cart.version });
    const quote = await checkout.quote(world.customer, { addressId: world.address });
    const placed = await checkout.place(world.customer, {
      quoteId: quote.quote.quoteId,
      intentId: quote.intentId,
      method: 'GATEWAY',
      idempotencyOperationId: uuidV7(),
    });
    expect(placed.confirmation).toBe('PENDING_PAYMENT');
    expect(await carts.get(world.customer)).toMatchObject({
      cartId: quote.quote.cartId,
      version: quote.quote.cartVersion,
      lines: [{ variantId: variant.id, quantity: '1' }],
    });
  } finally {
    await sql`UPDATE feature_flags SET enabled=false WHERE key='online_payments_enabled'`.execute(
      world.db.db,
    );
  }
}, 180000);
