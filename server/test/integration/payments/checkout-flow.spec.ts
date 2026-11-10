import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
import { SERVICEABILITY } from '../../../src/modules/serviceability/contracts/tokens.js';
import type { Serviceability } from '../../../src/modules/serviceability/contracts/serviceability.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let carts: CartService;
let checkout: CheckoutOperations;
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
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: world.services.databaseUrl,
    REDIS_URL: world.services.redisUrl,
  });
  app = await createApplication(env, [{ name: 'test', async check() {} }]);
  carts = app.get<CartService>(CART_SERVICE);
  checkout = app.get<CheckoutOperations>(CHECKOUT);
}, 120000);
afterAll(async () => {
  await app?.close();
  await closeP5World(world);
}, 120000);
beforeEach(async () => {
  const existing = await carts.get(world.customer);
  if (existing) await carts.deleteCart(world.customer, { expectedVersion: existing.version });
});
it('rolls back checkout if the selected store pauses after serviceability is checked', async () => {
  const variant = await world.variant({ stock: 10n });
  const cart = await carts.getOrCreateActiveCart(world.customer, world.address);
  await carts.putItem(world.customer, variant.id, '1', { expectedVersion: cart.version });
  const quoted = await checkout.quote(world.customer, { addressId: world.address });
  const serviceability = app.get<Serviceability>(SERVICEABILITY);
  const original = serviceability.check.bind(serviceability);
  serviceability.check = async (input) => {
    const result = await original(input);
    await sql`UPDATE stores SET status='PAUSED',pause_reason='test' WHERE id=${world.store}::uuid`.execute(
      world.db.db,
    );
    return result;
  };
  try {
    await expect(
      checkout.place(world.customer, {
        quoteId: quoted.quote.quoteId,
        intentId: quoted.intentId,
        method: 'GATEWAY',
        idempotencyOperationId: uuidV7(),
      }),
    ).rejects.toThrow('ADDRESS_NOT_SERVICEABLE');
    const rows = await sql<{ orders: string; reserved: string }>`SELECT
      (SELECT count(*)::text FROM orders WHERE metadata->>'intentId'=${quoted.intentId}) AS orders,
      (SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved`.execute(
      world.db.db,
    );
    expect(rows.rows[0]).toEqual({ orders: '0', reserved: '0' });
  } finally {
    serviceability.check = original;
    await sql`UPDATE stores SET status='ONLINE',pause_reason=NULL WHERE id=${world.store}::uuid`.execute(
      world.db.db,
    );
  }
});
it('places at most one order for concurrent different keys bound to the same intent', async () => {
  const variant = await world.variant({ stock: 10n });
  const cart = await carts.getOrCreateActiveCart(world.customer, world.address);
  await carts.putItem(world.customer, variant.id, '1', { expectedVersion: cart.version });
  const quote = await checkout.quote(world.customer, { addressId: world.address });
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      checkout.place(world.customer, {
        quoteId: quote.quote.quoteId,
        intentId: quote.intentId,
        method: 'GATEWAY',
        idempotencyOperationId: uuidV7(),
      }),
    ),
  );
  if (!results.some((r) => r.status === 'fulfilled'))
    throw new AggregateError(
      results.map((r) => (r.status === 'rejected' ? r.reason : null)),
      'Placement failures',
    );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const orders = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM orders WHERE metadata->>'intentId'=${quote.intentId}`.execute(
    world.db.db,
  );
  expect(orders.rows[0]?.count).toBe('1');
});
it.each(['price', 'configuration', 'cart quantity'] as const)(
  'rejects a quote after its %s changed without retaining stock or capacity',
  async (change) => {
    const variant = await world.variant({ stock: 10n, price: 20000n }),
      cart = await carts.getOrCreateActiveCart(world.customer, world.address);
    const written = await carts.putItem(world.customer, variant.id, '1', {
      expectedVersion: cart.version,
    });
    const quoted = await checkout.quote(world.customer, { addressId: world.address });
    if (change === 'price') await world.reprice(world.store, variant.id, 21000n);
    if (change === 'configuration')
      await sql`UPDATE app_config SET value='"500"'::jsonb,version=version+1 WHERE key='handlingFeePaise'`.execute(
        world.db.db,
      );
    if (change === 'cart quantity')
      await carts.putItem(world.customer, variant.id, '2', {
        expectedVersion: written.cart.version,
      });
    await expect(
      checkout.place(world.customer, {
        quoteId: quoted.quote.quoteId,
        intentId: quoted.intentId,
        method: 'GATEWAY',
        idempotencyOperationId: uuidV7(),
      }),
    ).rejects.toThrow(change === 'cart quantity' ? 'CONCURRENT_MODIFICATION' : 'PRICE_CHANGED');
    const effect = await sql<{ orders: string; reserved: string; capacity: string }>`SELECT
   (SELECT count(*)::text FROM orders WHERE metadata->>'intentId'=${quoted.intentId}) AS orders,
   (SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved,
   (SELECT count(*)::text FROM store_capacity_claims c JOIN orders o ON o.id::text=c.reference WHERE o.metadata->>'intentId'=${quoted.intentId}) AS capacity`.execute(
      world.db.db,
    );
    expect(effect.rows[0]).toEqual({ orders: '0', reserved: '0', capacity: '0' });
  },
);
