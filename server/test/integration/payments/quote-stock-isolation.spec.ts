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

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let carts: CartService;
let checkout: CheckoutOperations;
let otherAddress: string;
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
  otherAddress = uuidV7();
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) SELECT ${otherAddress}::uuid,${world.otherCustomer}::uuid,line1,pincode,contact_name,contact_phone,point,true FROM addresses WHERE id=${world.address}::uuid`.execute(
    world.db.db,
  );
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      DATABASE_POOL_MAX: '1',
      DB_ACQUIRE_TIMEOUT_MS: '2000',
    }),
  );
  carts = app.get<CartService>(CART_SERVICE);
  checkout = app.get<CheckoutOperations>(CHECKOUT);
}, 120000);
afterAll(async () => {
  await app?.close();
  if (world) await closeP5World(world);
}, 120000);
beforeEach(async () => {
  for (const user of [world.customer, world.otherCustomer]) {
    const cart = await carts.get(user);
    if (cart) await carts.deleteCart(user, { expectedVersion: cart.version });
  }
});
async function quote(user: string, address: string, variant: string) {
  const cart = await carts.getOrCreateActiveCart(user, address);
  await carts.putItem(user, variant, '1', { expectedVersion: cart.version });
  return checkout.quote(user, { addressId: address });
}
async function place(user: string, quoted: Awaited<ReturnType<typeof quote>>) {
  return checkout.place(user, {
    quoteId: quoted.quote.quoteId,
    intentId: quoted.intentId,
    method: 'GATEWAY',
    idempotencyOperationId: uuidV7(),
  });
}
it('places simultaneous independent customer orders with a one-connection application pool', async () => {
  const first = await world.variant({ stock: 10n });
  const second = await world.variant({ stock: 10n });
  const a = await quote(world.customer, world.address, first.id);
  const b = await quote(world.otherCustomer, otherAddress, second.id);
  const results = await Promise.all([place(world.customer, a), place(world.otherCustomer, b)]);
  expect(results).toHaveLength(2);
});
it.each(['same', 'different'] as const)(
  'stock reservations do not invalidate a second quote for %s SKU',
  async (kind) => {
    const first = await world.variant({ stock: 10n });
    const second = kind === 'same' ? first : await world.variant({ stock: 10n });
    const a = await quote(world.customer, world.address, first.id);
    const b = await quote(world.otherCustomer, otherAddress, second.id);
    await place(world.customer, a);
    await expect(place(world.otherCustomer, b)).resolves.toBeDefined();
    const result = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM orders WHERE metadata->>'intentId' IN (${a.intentId},${b.intentId})`.execute(
      world.db.db,
    );
    expect(result.rows[0]?.count).toBe('2');
  },
);
it.each(['price', 'mrp', 'tax', 'unpublished'] as const)(
  'genuine %s changes invalidate the quote without effects',
  async (change) => {
    const variant = await world.variant({ stock: 10n });
    const quoted = await quote(world.customer, world.address, variant.id);
    if (change === 'price') await world.reprice(world.store, variant.id, 11000n);
    if (change === 'mrp')
      await sql`UPDATE catalog_prices SET mrp_paise=mrp_paise+1 WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid AND valid_to IS NULL`.execute(
        world.db.db,
      );
    if (change === 'tax')
      await sql`UPDATE catalog_products SET gst_rate_bps=1200 WHERE id=${world.product}::uuid`.execute(
        world.db.db,
      );
    if (change === 'unpublished')
      await sql`UPDATE catalog_products SET published=false WHERE id=${world.product}::uuid`.execute(
        world.db.db,
      );
    try {
      await expect(place(world.customer, quoted)).rejects.toThrow('PRICE_CHANGED');
      const result = await sql<{
        orders: string;
        reserved: string;
      }>`SELECT (SELECT count(*)::text FROM orders WHERE metadata->>'intentId'=${quoted.intentId}) AS orders,(SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved`.execute(
        world.db.db,
      );
      expect(result.rows[0]).toEqual({ orders: '0', reserved: '0' });
    } finally {
      await sql`UPDATE catalog_products SET published=true,gst_rate_bps=500 WHERE id=${world.product}::uuid`.execute(
        world.db.db,
      );
    }
  },
);
it('a genuinely exhausted item rejects the second quote without creating an order or reservation', async () => {
  const variant = await world.variant({ stock: 1n });
  const a = await quote(world.customer, world.address, variant.id);
  const b = await quote(world.otherCustomer, otherAddress, variant.id);
  await place(world.customer, a);
  await expect(place(world.otherCustomer, b)).rejects.toThrow('INVENTORY_INSUFFICIENT');
  const result = await sql<{
    orders: string;
    reserved: string;
  }>`SELECT (SELECT count(*)::text FROM orders WHERE metadata->>'intentId'=${b.intentId}) AS orders,(SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved`.execute(
    world.db.db,
  );
  expect(result.rows[0]).toEqual({ orders: '0', reserved: '1' });
});
