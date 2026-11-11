import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { CartCleanup } from '../../../src/modules/cart/infrastructure/cart-cleanup.js';
import { PostgresCartIntents } from '../../../src/modules/cart/infrastructure/postgres-intents.js';
import { PostgresQuotes } from '../../../src/modules/cart/infrastructure/postgres-quotes.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresCouponAdministration } from '../../../src/modules/coupons/infrastructure/postgres-coupon-admin.js';
import { PostgresCoupons } from '../../../src/modules/coupons/infrastructure/postgres-coupons.js';
import { PostgresFirstOrderCheck } from '../../../src/modules/coupons/infrastructure/first-order-check.js';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let server: FastifyInstance;
let env: ReturnType<typeof readEnv>;
let tokenCounter = 0;
beforeAll(async () => {
  world = await createP5World();
  for (const [key, value] of [
    ['catalogMaxPerOrder', 5],
    ['maxCartLines', 2],
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
  env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: world.services.databaseUrl,
    REDIS_URL: world.services.redisUrl,
    RATE_LIMIT_DEFAULT_PER_MIN: '10000',
    RATE_LIMIT_AUTH_PER_MIN: '10000',
  });
  // Surface-only boot (the probes parameter excludes worker modules): these are
  // audience API tests; the retention worker is exercised directly below.
  app = await createApplication(env, [{ name: 'test', async check() {} }]);
  server = app.getHttpAdapter().getInstance();
}, 120000);
afterAll(async () => {
  await app?.close();
  await closeP5World(world);
}, 120000);
interface CartBody {
  cartId: string;
  version: number;
  storeId: string;
  couponCode: string | null;
  lines: { variantId: string; quantity: string; unitPricePaise: string }[];
  issues: { code: string; variantId?: string; detail?: string }[];
  clamped?: boolean;
}
interface PutResult {
  cart: CartBody;
  clamped: boolean;
}
interface QuoteBody {
  quoteId?: string;
  cartId: string;
  storeId: string;
  lines: { variantId: string; quantity: string; unitPricePaise: string; taxPaise: string }[];
  issues: { code: string; variantId?: string }[];
  totalPaise: string;
  subtotalPaise: string;
  taxTotalPaise: string;
  couponDiscountPaise: string;
}
/** A fresh customer identity per test keeps cart state and Redis counters isolated. */
const customerIds = new Map<string, string>();
interface Customer {
  token: string;
  userId: string;
  addressId: string;
  otherAddressId: string;
}
async function newCustomer(): Promise<Customer> {
  tokenCounter += 1;
  const sub = `p5-it-${tokenCounter}`;
  const user = uuidV7();
  const addressId = uuidV7();
  const otherAddressId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER',${sub},${sub + '@example.invalid'},'customer')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${user}::uuid,'CUSTOMER')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${addressId}::uuid,${user}::uuid,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)`.execute(
    world.db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${otherAddressId}::uuid,${user}::uuid,'road','560002','name','+919876543210',ST_SetSRID(ST_MakePoint(76.5,11.5),4326)::geography,false)`.execute(
    world.db.db,
  );
  customerIds.set(sub, user);
  const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db);
  return {
    token: await tokens.issue('CUSTOMER', sub, 'customer', 'access'),
    userId: user,
    addressId,
    otherAddressId,
  };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const keyHeaders = (key: string) => ({ 'idempotency-key': key });
async function getCart(token: string) {
  const result = await server.inject({
    method: 'GET',
    url: '/v1/customer/cart',
    headers: auth(token),
  });
  if (result.statusCode === 404) return null;
  expect(result.statusCode).toBe(200);
  return result.json<CartBody>();
}
async function putItem(
  token: string,
  variantId: string,
  quantity: string,
  version: number,
  addressId?: string,
  key = uuidV7(),
) {
  return server.inject({
    method: 'PUT',
    url: `/v1/customer/cart/items/${variantId}`,
    headers: { ...auth(token), ...keyHeaders(key) },
    payload: { quantity, version, ...(addressId ? { addressId } : {}) },
  });
}
async function validate(token: string, addressId: string, payload: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    url: '/v1/customer/cart/validate',
    headers: { ...auth(token), ...keyHeaders(uuidV7()) },
    payload: { addressId, ...payload },
  });
}
it('a cart needs an address on first write; reads before that 404', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const missing = await getCart(token);
  expect(missing).toBeNull();
  const result = await server.inject({
    method: 'GET',
    url: '/v1/customer/cart',
    headers: auth(token),
  });
  expect(result.statusCode).toBe(404);
  const item = await world.variant();
  const noAddress = await putItem(token, item.id, '1', 1);
  expect(noAddress.statusCode).toBe(404);
  const created = await putItem(token, item.id, '1', 1, customer.addressId);
  expect(created.statusCode).toBe(200);
  expect(created.json<PutResult>().cart.version).toBeGreaterThanOrEqual(1);
  expect(created.json<PutResult>().cart.lines).toHaveLength(1);
  expect(created.json<PutResult>().cart.lines[0]!.unitPricePaise).toBe('10000');
  expect(created.json<PutResult>().cart.lines[0]).toMatchObject({
    productId: world.product,
    productName: 'Milk',
    variantName: 'Unit',
    image: null,
  });
  // The response version is authoritative for the next write.
  const reread = (await getCart(token))!;
  expect(reread.version).toBe(created.json<PutResult>().cart.version);
});
it('retries with the same key replay the stored response and keyless writes are rejected', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant();
  const key = uuidV7();
  const first = await putItem(token, item.id, '2', 1, customer.addressId, key);
  expect(first.statusCode).toBe(200);
  const second = await putItem(token, item.id, '2', 1, customer.addressId, key);
  expect(second.statusCode).toBe(200);
  expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
  const conflicting = await putItem(token, item.id, '3', 1, customer.addressId, key);
  expect(conflicting.statusCode).toBe(409);
  expect(conflicting.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  const withoutKey = await putItem(token, item.id, '2', 2, undefined, '');
  expect(withoutKey.statusCode).toBe(400);
});
it('rejects unknown cart item fields without changing the existing cart', async () => {
  const customer = await newCustomer();
  const item = await world.variant();
  const created = await putItem(customer.token, item.id, '1', 1, customer.addressId);
  expect(created.statusCode).toBe(200);
  const before = (await getCart(customer.token))!;
  const invalid = await server.inject({
    method: 'PUT',
    url: `/v1/customer/cart/items/${item.id}`,
    headers: { ...auth(customer.token), ...keyHeaders(uuidV7()) },
    payload: { quantity: '2', version: before.version, unexpected: 'canary' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.body).not.toContain('canary');
  const after = (await getCart(customer.token))!;
  expect(after.version).toBe(before.version);
  expect(after.lines).toEqual(before.lines);
});
it('stale versions conflict and every accepted mutation bumps the version', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant();
  await putItem(token, item.id, '1', 1, customer.addressId);
  const version = (await getCart(token))!.version;
  const stale = await putItem(token, item.id, '2', version - 1);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('CONCURRENT_MODIFICATION');
  const accepted = await putItem(token, item.id, '2', version);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json<PutResult>().cart.version).toBe(version + 1);
});
it('quantities clamp to the per-order maximum and to available stock with issues', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant();
  await world.stock(world.store, item.id, 50n);
  await putItem(token, item.id, '1', 1, customer.addressId);
  let cart = (await getCart(token))!;
  const overMax = await putItem(token, item.id, '50', cart.version);
  expect(overMax.statusCode).toBe(200);
  expect(overMax.json<PutResult>().clamped).toBe(true);
  expect(overMax.json<PutResult>().cart.lines[0]!.quantity).toBe('5');
  expect(overMax.json<PutResult>().cart.issues.some((i) => i.code === 'QTY_REDUCED')).toBe(true);
  await world.stock(world.store, item.id, 3n);
  cart = (await getCart(token))!;
  const overStock = await putItem(token, item.id, '5', cart.version);
  expect(overStock.statusCode).toBe(200);
  expect(overStock.json<PutResult>().cart.lines[0]!.quantity).toBe('3');
  expect(
    overStock
      .json<PutResult>()
      .cart.issues.some((i) => i.code === 'QTY_REDUCED' && i.variantId === item.id),
  ).toBe(true);
});
it('items without saleable stock are refused explicitly', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant();
  await world.stock(world.store, item.id, 0n);
  const result = await putItem(token, item.id, '1', 1, customer.addressId);
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('INVENTORY_INSUFFICIENT');
});
it('the distinct line cap is enforced with a 400', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const items = [await world.variant(), await world.variant(), await world.variant()];
  let version = 1;
  const statuses: number[] = [];
  for (const item of items) {
    const result = await putItem(token, item.id, '1', version, customer.addressId);
    statuses.push(result.statusCode);
    if (result.statusCode === 200) version = result.json<PutResult>().cart.version;
  }
  expect(statuses).toEqual([200, 200, 400]);
  const cart = await getCart(token);
  expect(cart!.lines).toHaveLength(2);
});
it('quantity zero removes the line and delete-cart clears everything', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant();
  await putItem(token, item.id, '1', 1, customer.addressId);
  let cart = (await getCart(token))!;
  const removed = await putItem(token, item.id, '0', cart.version);
  expect(removed.statusCode).toBe(200);
  expect(removed.json<PutResult>().cart.lines).toHaveLength(0);
  cart = (await getCart(token))!;
  await putItem(token, item.id, '1', cart.version, customer.addressId);
  cart = (await getCart(token))!;
  const invalidVersion = await server.inject({
    method: 'DELETE',
    url: '/v1/customer/cart',
    headers: { ...auth(token), ...keyHeaders(uuidV7()) },
    query: { version: '0' },
  });
  expect(invalidVersion.statusCode).toBe(400);
  const deletionKey = uuidV7();
  const removeCart = (version: number) =>
    server.inject({
      method: 'DELETE',
      url: '/v1/customer/cart',
      headers: { ...auth(token), ...keyHeaders(deletionKey) },
      query: { version: String(version) },
    });
  const deleted = await removeCart(cart.version);
  expect(deleted.statusCode).toBe(200);
  expect((await removeCart(cart.version)).statusCode).toBe(200);
  const changed = await removeCart(cart.version + 1);
  expect(changed.statusCode).toBe(409);
  expect(changed.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  expect(await getCart(token)).toBeNull();
});
it('store change flags unavailable lines, reprices and clamps without dropping anything', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const gone = await world.variant();
  const moved = await world.variant({ price: 10000n });
  await putItem(token, gone.id, '2', 1, customer.addressId);
  const cart = (await getCart(token))!;
  await putItem(token, moved.id, '3', cart.version, customer.addressId);
  await world.stock(world.otherStore, gone.id, 0n);
  await world.stock(world.otherStore, moved.id, 1n);
  await world.reprice(world.otherStore, moved.id, 12500n);
  const result = await validate(token, customer.otherAddressId);
  expect(result.statusCode).toBe(200);
  const quote = result.json<QuoteBody>();
  expect(quote.storeId).toBe(world.otherStore);
  // Only the saleable line is priced; the unavailable one is flagged, not charged.
  expect(quote.lines).toHaveLength(1);
  const codes = quote.issues.map((i) => [i.code, i.variantId]);
  expect(codes).toContainEqual(['ITEM_UNAVAILABLE', gone.id]);
  expect(codes).toContainEqual(['PRICE_CHANGED', moved.id]);
  expect(codes).toContainEqual(['QTY_REDUCED', moved.id]);
  const movedLine = quote.lines.find((l) => l.variantId === moved.id)!;
  expect(movedLine.unitPricePaise).toBe('12500');
  // The rebind retains every stored line in the cart itself.
  const rebound = (await getCart(token))!;
  expect(rebound.storeId).toBe(world.otherStore);
  expect(rebound.lines).toHaveLength(2);
  const cartIssues = rebound.issues.map((i) => [i.code, i.variantId]);
  expect(cartIssues).toContainEqual(['ITEM_UNAVAILABLE', gone.id]);
  expect(cartIssues).toContainEqual(['PRICE_CHANGED', moved.id]);
  expect(cartIssues).toContainEqual(['QTY_REDUCED', moved.id]);
});
it('coupon apply normalizes codes, refuses stacking and removal clears it', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const administration = new PostgresCouponAdministration(
    world.db.db,
    new DatabaseIdentityAccess(world.db.db),
  );
  const first = await administration.create(world.admin, {
    code: 'cartfive',
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
  const second = await administration.create(world.admin, {
    code: 'cartsix',
    kind: 'FLAT',
    valuePaise: '100',
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
  expect(first.code).toBe('CARTFIVE');
  const item = await world.variant();
  await putItem(token, item.id, '2', 1, customer.addressId);
  let cart = (await getCart(token))!;
  const applied = await server.inject({
    method: 'POST',
    url: '/v1/customer/cart/coupon',
    headers: { ...auth(token), ...keyHeaders(uuidV7()) },
    payload: { code: '  cartfive ', version: cart.version },
  });
  expect(applied.statusCode).toBe(200);
  expect(applied.json<CartBody>().couponCode).toBe('CARTFIVE');
  cart = (await getCart(token))!;
  const stacked = await server.inject({
    method: 'POST',
    url: '/v1/customer/cart/coupon',
    headers: { ...auth(token), ...keyHeaders(uuidV7()) },
    payload: { code: second.code.toLowerCase(), version: cart.version },
  });
  expect(stacked.statusCode).toBe(409);
  const unknown = await server.inject({
    method: 'POST',
    url: '/v1/customer/cart/coupon',
    headers: { ...auth(token), ...keyHeaders(uuidV7()) },
    payload: { code: 'NO-SUCH-CODE', version: cart.version },
  });
  expect(unknown.statusCode).toBe(400);
  cart = (await getCart(token))!;
  const removed = await server.inject({
    method: 'DELETE',
    url: '/v1/customer/cart/coupon',
    headers: { ...auth(token), ...keyHeaders(uuidV7()) },
    query: { version: String(cart.version) },
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json<CartBody>().couponCode).toBeNull();
});
it('wrong audiences are rejected and carts are strictly per-user', async () => {
  const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db);
  const workforce = await tokens.issue('WORKFORCE', 'p5-admin', 'admin', 'access');
  const wrongAudience = await server.inject({
    method: 'GET',
    url: '/v1/customer/cart',
    headers: auth(workforce),
  });
  expect(wrongAudience.statusCode).toBe(401);
  const customer = await newCustomer();
  const token = customer.token;
  expect(await getCart(token)).toBeNull();
  // A second user's cart is never visible: GET is scoped to the principal.
  const other = await newCustomer();
  const item = await world.variant();
  await putItem(other.token, item.id, '1', 1, other.addressId);
  expect(await getCart(token)).toBeNull();
  expect((await getCart(other.token))!.lines).toHaveLength(1);
});
it('retention sweeps delete only carts idle beyond the configured age', async () => {
  const stale = await newCustomer();
  const fresh = await newCustomer();
  const item = await world.variant();
  await putItem(stale.token, item.id, '1', 1, stale.addressId);
  await putItem(fresh.token, item.id, '1', 1, fresh.addressId);
  const cleanup = new CartCleanup(world.db.db, world.config);
  await sql`UPDATE carts SET updated_at=clock_timestamp() - interval '400 days' WHERE user_id=${stale.userId}::uuid`.execute(
    world.db.db,
  );
  const removed = await cleanup.deleteIdleCarts();
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(await getCart(stale.token)).toBeNull();
  expect(await getCart(fresh.token)).not.toBeNull();
});
it('validate computes inclusive totals without persisting any snapshot', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant({ price: 10500n });
  await putItem(token, item.id, '1', 1, customer.addressId);
  const result = await validate(token, customer.addressId, { tipPaise: '500' });
  expect(result.statusCode).toBe(200);
  const quote = result.json<QuoteBody>();
  expect(quote.lines[0]!.taxPaise).toBe('500');
  expect(quote.taxTotalPaise).toBe('500');
  expect(quote.subtotalPaise).toBe('10500');
  expect(quote.totalPaise).toBe('11000');
  const snapshots = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM quote_snapshots`.execute(world.db.db);
  expect(snapshots.rows[0]!.n).toBe('0');
});
it('quote refresh persists superseding expiring snapshots with enforced ownership', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const other = await newCustomer();
  const item = await world.variant();
  await putItem(token, item.id, '2', 1, customer.addressId);
  const configService = new ConfigService(world.db.db);
  const quotes = new PostgresQuotes(
    world.db.db,
    configService,
    new PostgresCoupons(world.db.db, new PostgresFirstOrderCheck(world.db.db)),
  );
  const first = await quotes.refresh({ userId: customer.userId, addressId: customer.addressId });
  expect(first.status).toBe('ACTIVE');
  expect(first.lines[0]!.quantity).toBe('2');
  const second = await quotes.refresh({ userId: customer.userId, addressId: customer.addressId });
  expect(second.quoteId).not.toBe(first.quoteId);
  const statuses = await sql<{
    status: string;
  }>`SELECT status FROM quote_snapshots WHERE id=${first.quoteId}::uuid`.execute(world.db.db);
  expect(statuses.rows[0]!.status).toBe('SUPERSEDED');
  const windowSeconds = await configService.get('paymentWindowSeconds');
  const ttl = (new Date(second.expiresAt).getTime() - new Date(second.createdAt).getTime()) / 1000;
  expect(ttl).toBeCloseTo(windowSeconds, 0);
  expect(await quotes.get(second.quoteId, customer.userId)).toMatchObject({ status: 'ACTIVE' });
  await expect(quotes.get(second.quoteId, other.userId)).rejects.toThrow('RESOURCE_NOT_FOUND');
  await sql`UPDATE quote_snapshots SET expires_at=clock_timestamp() - interval '1 second' WHERE id=${second.quoteId}::uuid`.execute(
    world.db.db,
  );
  await expect(quotes.get(second.quoteId, customer.userId)).rejects.toThrow('QUOTE_EXPIRED');
});
it('stale prices surface PRICE_CHANGED at refresh with fresh-priced lines', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant({ price: 10000n });
  await putItem(token, item.id, '1', 1, customer.addressId);
  await world.reprice(world.store, item.id, 14000n);
  const quotes = new PostgresQuotes(
    world.db.db,
    new ConfigService(world.db.db),
    new PostgresCoupons(world.db.db, new PostgresFirstOrderCheck(world.db.db)),
  );
  const snapshot = await quotes.refresh({ userId: customer.userId, addressId: customer.addressId });
  expect(snapshot.issues.some((i) => i.code === 'PRICE_CHANGED' && i.variantId === item.id)).toBe(
    true,
  );
  expect(snapshot.lines[0]!.unitPricePaise).toBe('14000');
  expect(snapshot.priceVersion).toBeDefined();
  const revision = await sql<{
    revision: string;
  }>`SELECT revision::text FROM catalog_revision WHERE singleton`.execute(world.db.db);
  expect(snapshot.priceVersion).toBe(revision.rows[0]!.revision);
});
it('intents fence a single placement per cart version', async () => {
  const customer = await newCustomer();
  const token = customer.token;
  const item = await world.variant();
  await putItem(token, item.id, '1', 1, customer.addressId);
  const quotes = new PostgresQuotes(
    world.db.db,
    new ConfigService(world.db.db),
    new PostgresCoupons(world.db.db, new PostgresFirstOrderCheck(world.db.db)),
  );
  const snapshot = await quotes.refresh({ userId: customer.userId, addressId: customer.addressId });
  const intents = new PostgresCartIntents(world.db.db);
  const intent = await intents.issue(snapshot.cartId, snapshot.cartVersion, snapshot.quoteId);
  expect(intent.intentId).toBeDefined();
  const again = await intents.issue(snapshot.cartId, snapshot.cartVersion, snapshot.quoteId);
  expect(again.intentId).toBe(intent.intentId);
  await expect(intents.issue(snapshot.cartId, snapshot.cartVersion, uuidV7())).rejects.toThrow(
    'RESOURCE_NOT_FOUND',
  );
  const consume = () =>
    world.db.db
      .transaction()
      .execute(async (tx) =>
        intents.consume(
          intent.intentId,
          { cartId: snapshot.cartId, cartVersion: snapshot.cartVersion, quoteId: snapshot.quoteId },
          tx,
        ),
      );
  await consume();
  await expect(consume()).rejects.toThrow('CART_INTENT_CONSUMED');
  await expect(
    world.db.db
      .transaction()
      .execute(async (tx) =>
        intents.consume(
          uuidV7(),
          { cartId: snapshot.cartId, cartVersion: snapshot.cartVersion, quoteId: snapshot.quoteId },
          tx,
        ),
      ),
  ).rejects.toThrow('RESOURCE_NOT_FOUND');
});

it('a scoped coupon discounts only eligible non-excluded quote lines', async () => {
  const customer = await newCustomer(),
    excluded = await world.variant({ price: 10000n }),
    eligible = await world.variant({ price: 20000n });
  const administration = new PostgresCouponAdministration(
    world.db.db,
    new DatabaseIdentityAccess(world.db.db),
  );
  await administration.create(world.admin, {
    code: 'EXCLUDE-ONE',
    kind: 'PERCENT',
    valuePaise: '1000',
    maxCapPaise: null,
    minOrderPaise: '0',
    perUserLimit: null,
    globalLimit: null,
    validFrom: null,
    validTo: null,
    storeId: world.store,
    categoryId: world.category,
    productId: world.product,
    excludedVariantIds: [excluded.id],
    stackable: false,
    firstOrderOnly: false,
  });
  expect((await putItem(customer.token, excluded.id, '1', 1, customer.addressId)).statusCode).toBe(
    200,
  );
  const current = (await getCart(customer.token))!;
  expect((await putItem(customer.token, eligible.id, '1', current.version)).statusCode).toBe(200);
  const result = await validate(customer.token, customer.addressId, { couponCode: 'EXCLUDE-ONE' });
  expect(result.statusCode).toBe(200);
  const quote = result.json<QuoteBody>();
  expect(quote.couponDiscountPaise).toBe('2000');
  expect(quote.lines.find((l) => l.variantId === excluded.id)).toMatchObject({
    discountPaise: '0',
    lineTotalPaise: '10000',
  });
  expect(quote.lines.find((l) => l.variantId === eligible.id)).toMatchObject({
    discountPaise: '2000',
    lineTotalPaise: '18000',
  });
});
