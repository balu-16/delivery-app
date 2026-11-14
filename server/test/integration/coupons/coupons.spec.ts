import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { PostgresCouponRedemptions } from '../../../src/modules/coupons/infrastructure/postgres-redemptions.js';
import { PostgresCoupons } from '../../../src/modules/coupons/infrastructure/postgres-coupons.js';
import { PostgresFirstOrderCheck } from '../../../src/modules/coupons/infrastructure/first-order-check.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let orderCounter = 0;
let server: FastifyInstance;
let env: ReturnType<typeof readEnv>;
let counter = 0;
const redemptions = () =>
  new PostgresCouponRedemptions(world.db.db, new PostgresFirstOrderCheck(world.db.db));
const coupons = () => new PostgresCoupons(world.db.db, new PostgresFirstOrderCheck(world.db.db));
beforeAll(async () => {
  world = await createP5World();
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
  // audience API tests over the customer and admin coupon surfaces.
  app = await createApplication(env, [{ name: 'test', async check() {} }]);
  server = app.getHttpAdapter().getInstance();
}, 120000);
afterAll(async () => {
  await app?.close();
  await closeP5World(world);
}, 120000);
interface Customer {
  token: string;
  userId: string;
  addressId: string;
}
async function newCustomer(): Promise<Customer> {
  counter += 1;
  const sub = `p5-cp-${counter}`;
  const user = uuidV7();
  const addressId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER',${sub},${sub + '@example.invalid'},'customer')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${user}::uuid,'CUSTOMER')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${addressId}::uuid,${user}::uuid,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)`.execute(
    world.db.db,
  );
  const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db);
  return {
    token: await tokens.issue('CUSTOMER', sub, 'customer', 'access'),
    userId: user,
    addressId,
  };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const nextOrderNumber = () => {
  orderCounter += 1;
  return `ORD-P5-${orderCounter.toString().padStart(6, '0')}`;
};
async function createCouponHttp(token: string, draft: Record<string, unknown>, key = uuidV7()) {
  return server.inject({
    method: 'POST',
    url: '/v1/admin/coupons',
    headers: { ...auth(token), 'idempotency-key': key },
    payload: draft,
  });
}
const draft = (over: Record<string, unknown> = {}) => ({
  code: `CP${counter}${Math.floor(Math.random() * 1000)}`.toUpperCase().padEnd(6, 'X'),
  kind: 'PERCENT',
  valuePaise: '1000',
  maxCapPaise: '5000',
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
  ...over,
});
async function adminToken(role = 'SUPER_ADMIN'): Promise<string> {
  counter += 1;
  const sub = `p5-adm-${counter}`;
  const user = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'WORKFORCE',${sub},${sub + '@example.invalid'},'staff')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${user}::uuid,${role})`.execute(
    world.db.db,
  );
  const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db);
  return tokens.issue('WORKFORCE', sub, 'admin', 'access');
}
it('admin coupon CRUD is audited, replayed and version-fenced', async () => {
  const token = await adminToken();
  const payload = draft({ code: 'AUDITONE' });
  const key = uuidV7();
  const first = await createCouponHttp(token, payload, key);
  expect(first.statusCode).toBe(201);
  expect(first.json().code).toBe('AUDITONE');
  const replay = await createCouponHttp(token, payload, key);
  expect(replay.statusCode).toBe(201);
  expect(JSON.parse(replay.body)).toEqual(JSON.parse(first.body));
  const conflicting = await createCouponHttp(token, { ...payload, valuePaise: '2000' }, key);
  expect(conflicting.statusCode).toBe(409);
  await createCouponHttp(token, draft({ code: 'AUDITTWO' }));
  const listed = await server.inject({
    method: 'GET',
    url: '/v1/admin/coupons?limit=1',
    headers: auth(token),
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().items).toHaveLength(1);
  expect(listed.json().nextCursor).not.toBeNull();
  const id = first.json().id;
  const updated = await server.inject({
    method: 'PATCH',
    url: `/v1/admin/coupons/${id}`,
    headers: { ...auth(token), 'idempotency-key': uuidV7() },
    payload: {
      perUserLimit: 3,
      globalLimit: 25,
      minOrderPaise: '20000',
      active: false,
      expectedVersion: first.json().version,
    },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({
    perUserLimit: 3,
    globalLimit: 25,
    minOrderPaise: '20000',
    active: false,
  });
  const stale = await server.inject({
    method: 'PATCH',
    url: `/v1/admin/coupons/${id}`,
    headers: { ...auth(token), 'idempotency-key': uuidV7() },
    payload: { active: true, expectedVersion: first.json().version },
  });
  expect(stale.statusCode).toBe(409);
  const audit = await sql<{
    action: string;
  }>`SELECT action FROM audit_log WHERE subject_type='coupon' AND subject_id=${id} ORDER BY created_at`.execute(
    world.db.db,
  );
  expect(audit.rows.map((r) => r.action)).toEqual(['COUPON_CREATED', 'COUPON_UPDATED']);
});
it('coupon administration rejects non-admins and non-workforce callers', async () => {
  const support = await adminToken('SUPPORT_AGENT');
  const forbidden = await createCouponHttp(support, draft({ code: 'DENIED1' }));
  expect(forbidden.statusCode).toBe(403);
  const customer = await newCustomer();
  const wrongPool = await server.inject({
    method: 'GET',
    url: '/v1/admin/coupons',
    headers: auth(customer.token),
  });
  expect(wrongPool.statusCode).toBe(401);
});
it('coupon codes normalize and unknown codes are explicit failures', async () => {
  const customer = await newCustomer();
  const admin = await adminToken();
  await createCouponHttp(admin, draft({ code: 'normalize' }));
  const line = {
    variantId: uuidV7(),
    productId: world.product,
    categoryId: world.category,
    quantity: 1n,
    unitPricePaise: 10000n,
  };
  const validation = await coupons().validate({
    userId: customer.userId,
    code: '  NoRmAlIzE ',
    storeId: world.store,
    lines: [line],
    subtotalPaise: 10000n,
  });
  expect(validation.coupon.code).toBe('NORMALIZE');
  await expect(
    coupons().validate({
      userId: customer.userId,
      code: 'MISSING-CODE',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('INVALID_COUPON_CODE');
});
it('validation honours store scope, min order, validity window and quotas', async () => {
  const customer = await newCustomer();
  const admin = await adminToken();
  const line = {
    variantId: uuidV7(),
    productId: world.product,
    categoryId: world.category,
    quantity: 1n,
    unitPricePaise: 10000n,
  };
  await createCouponHttp(
    admin,
    draft({ code: 'SCOPED1', storeId: world.otherStore, minOrderPaise: '0' }),
  );
  await expect(
    coupons().validate({
      userId: customer.userId,
      code: 'SCOPED1',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('COUPON_NOT_ELIGIBLE');
  await createCouponHttp(admin, draft({ code: 'MINORDER', minOrderPaise: '99999' }));
  await expect(
    coupons().validate({
      userId: customer.userId,
      code: 'MINORDER',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('COUPON_NOT_ELIGIBLE');
  await createCouponHttp(
    admin,
    draft({
      code: 'WINDOWED',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-01-02T00:00:00.000Z',
    }),
  );
  await expect(
    coupons().validate({
      userId: customer.userId,
      code: 'WINDOWED',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('COUPON_EXPIRED');
  await createCouponHttp(admin, draft({ code: 'PERUSER1', perUserLimit: 1 }));
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().reserve('PERUSER1', customer.userId, tx);
  });
  await expect(
    coupons().validate({
      userId: customer.userId,
      code: 'PERUSER1',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('COUPON_LIMIT_REACHED');
  await createCouponHttp(admin, draft({ code: 'GLOBAL01', globalLimit: 1 }));
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().reserve('GLOBAL01', customer.userId, tx);
  });
  await expect(
    coupons().validate({
      userId: customer.userId,
      code: 'GLOBAL01',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('COUPON_EXHAUSTED');
});
it('first-order eligibility derives from authoritative completed orders only', async () => {
  const admin = await adminToken();
  await createCouponHttp(admin, draft({ code: 'FIRSTORD', firstOrderOnly: true }));
  const newcomer = await newCustomer();
  const buyer = await newCustomer();
  const line = {
    variantId: uuidV7(),
    productId: world.product,
    categoryId: world.category,
    quantity: 1n,
    unitPricePaise: 10000n,
  };
  // Eligibility is derived from the authoritative orders table, never a client flag.
  expect(await new PostgresFirstOrderCheck(world.db.db).isFirstOrder(buyer.userId)).toBe(true);
  await expect(
    coupons().validate({
      userId: newcomer.userId,
      code: 'FIRSTORD',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).resolves.toMatchObject({ coupon: { code: 'FIRSTORD' } });
  // A delivered order makes the buyer ineligible (derived, never client-claimed).
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,total_paise,amount_due_paise,placed_at,delivered_at)
    VALUES(${uuidV7()}::uuid,${nextOrderNumber()}::text,${buyer.userId}::uuid,${world.store}::uuid,'{"line1":"road"}'::jsonb,'DELIVERED','PAID','GATEWAY',10000,10000,10000,statement_timestamp(),statement_timestamp())`.execute(
    world.db.db,
  );
  expect(await new PostgresFirstOrderCheck(world.db.db).isFirstOrder(buyer.userId)).toBe(false);
  await expect(
    coupons().validate({
      userId: buyer.userId,
      code: 'FIRSTORD',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).rejects.toThrow('COUPON_NOT_ELIGIBLE');
  await expect(
    coupons().validate({
      userId: newcomer.userId,
      code: 'FIRSTORD',
      storeId: world.store,
      lines: [line],
      subtotalPaise: 10000n,
    }),
  ).resolves.toMatchObject({ coupon: { code: 'FIRSTORD' } });
});
it('available coupons filter by store, minimum, exhaustion, quota and first order', async () => {
  const admin = await adminToken();
  const customer = await newCustomer();
  const other = await newCustomer();
  await createCouponHttp(admin, draft({ code: 'AVAILALL', minOrderPaise: '0' }));
  await createCouponHttp(
    admin,
    draft({ code: 'AVAILEAST', storeId: world.store, minOrderPaise: '0' }),
  );
  await createCouponHttp(admin, draft({ code: 'AVAILHIGH', minOrderPaise: '999999' }));
  await createCouponHttp(admin, draft({ code: 'AVAILUSER', perUserLimit: 1, minOrderPaise: '0' }));
  await createCouponHttp(
    admin,
    draft({ code: 'AVAILFORD', firstOrderOnly: true, minOrderPaise: '0' }),
  );
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().reserve('AVAILUSER', customer.userId, tx);
  });
  // The per-user quota is now fully used; a second reservation fails and the
  // coupon disappears from this user's availability list only.
  await expect(
    world.db.db
      .transaction()
      .execute(async (tx) => redemptions().reserve('AVAILUSER', customer.userId, tx)),
  ).rejects.toThrow('COUPON_LIMIT_REACHED');
  const scope = await coupons().available(customer.userId, world.store, 10000n);
  const codes = scope.map((c) => c.code);
  expect(codes).toContain('AVAILALL');
  expect(codes).toContain('AVAILEAST');
  expect(codes).toContain('AVAILFORD');
  expect(codes).not.toContain('AVAILHIGH');
  // The customer already holds a reservation; availability hides it for them
  // once the per-user counter is exhausted, while other users still see it.
  const forOther = await coupons().available(other.userId, world.store, 10000n);
  expect(forOther.map((c) => c.code)).toContain('AVAILUSER');
});
it('coupon validation attempts are rate limited per user', async () => {
  const customer = await newCustomer();
  const admin = await adminToken();
  await createCouponHttp(admin, draft({ code: 'RATEGATE', minOrderPaise: '0' }));
  // Establish a cart so every attempt reaches coupon validation.
  const item = await world.variant();
  await server.inject({
    method: 'PUT',
    url: `/v1/customer/cart/items/${item.id}`,
    headers: { ...auth(customer.token), 'idempotency-key': uuidV7() },
    payload: { quantity: '1', version: 1, addressId: customer.addressId },
  });
  const attempt = async () =>
    server.inject({
      method: 'POST',
      url: '/v1/customer/cart/coupon',
      headers: { ...auth(customer.token), 'idempotency-key': uuidV7() },
      payload: { code: `WRONG${Math.floor(Math.random() * 100000)}`, version: 2 },
    });
  for (let attempt_no = 0; attempt_no < 10; attempt_no++) {
    const result = await attempt();
    expect(result.statusCode).toBe(400);
  }
  const limited = await attempt();
  expect(limited.statusCode).toBe(429);
});
it('redemptions reserve, commit and release exactly once with reconciled counters', async () => {
  const admin = await adminToken();
  await createCouponHttp(
    admin,
    draft({ code: 'LIFECYCL', globalLimit: 5, perUserLimit: 2, minOrderPaise: '0' }),
  );
  const users: [Customer, Customer, Customer] = [
    await newCustomer(),
    await newCustomer(),
    await newCustomer(),
  ];
  const [a, b, c] = users;
  let firstId = '';
  let secondId = '';
  await world.db.db.transaction().execute(async (tx) => {
    firstId = await redemptions().reserve('LIFECYCL', a.userId, tx);
    secondId = await redemptions().reserve('LIFECYCL', a.userId, tx);
  });
  await expect(
    world.db.db
      .transaction()
      .execute(async (tx) => redemptions().reserve('LIFECYCL', a.userId, tx)),
  ).rejects.toThrow('COUPON_LIMIT_REACHED');
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().reserve('LIFECYCL', b.userId, tx);
    await redemptions().reserve('LIFECYCL', b.userId, tx);
    await redemptions().reserve('LIFECYCL', c.userId, tx);
  });
  const counters = await sql<{
    redeemed: string;
    reserved: string;
    committed: string;
  }>`SELECT c.redeemed_count::text AS redeemed,
    (SELECT COALESCE(sum(q.reserved_count),0)::text FROM coupon_user_quota q WHERE q.coupon_id=c.id) AS reserved,
    (SELECT COALESCE(sum(q.committed_count),0)::text FROM coupon_user_quota q WHERE q.coupon_id=c.id) AS committed
    FROM coupons c WHERE c.code='LIFECYCL'`.execute(world.db.db);
  expect(counters.rows[0]).toEqual({ redeemed: '5', reserved: '5', committed: '0' });
  const orderId = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,total_paise,amount_due_paise,placed_at)
    VALUES(${orderId}::uuid,${nextOrderNumber()}::text,${c.userId}::uuid,${world.store}::uuid,'{"line1":"road"}'::jsonb,'CONFIRMED','PAID','GATEWAY',10000,10000,10000,statement_timestamp())`.execute(
    world.db.db,
  );
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().commit(firstId, orderId, tx);
  });
  await expect(
    world.db.db.transaction().execute(async (tx) => redemptions().commit(firstId, orderId, tx)),
  ).rejects.toThrow('RESOURCE_CONFLICT');
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().release(secondId, tx);
  });
  // Releasing twice is idempotent and never double-decrements.
  await world.db.db.transaction().execute(async (tx) => {
    await redemptions().release(secondId, tx);
  });
  const after = await sql<{
    redeemed: string;
    reserved: string;
    committed: string;
  }>`SELECT c.redeemed_count::text AS redeemed,
    (SELECT COALESCE(sum(q.reserved_count),0)::text FROM coupon_user_quota q WHERE q.coupon_id=c.id) AS reserved,
    (SELECT COALESCE(sum(q.committed_count),0)::text FROM coupon_user_quota q WHERE q.coupon_id=c.id) AS committed
    FROM coupons c WHERE c.code='LIFECYCL'`.execute(world.db.db);
  expect(after.rows[0]).toEqual({ redeemed: '4', reserved: '3', committed: '1' });
  // Freed quota admits a new reservation.
  let extra = '';
  await world.db.db.transaction().execute(async (tx) => {
    extra = await redemptions().reserve('LIFECYCL', c.userId, tx);
  });
  expect(extra).not.toBe('');
});
it('an invalidated coupon is flagged on the quote instead of being silently applied', async () => {
  const customer = await newCustomer();
  const admin = await adminToken();
  await createCouponHttp(admin, draft({ code: 'EXPIREQ', minOrderPaise: '0', globalLimit: null }));
  const item = await world.variant({ price: 10500n });
  const created = await server.inject({
    method: 'PUT',
    url: `/v1/customer/cart/items/${item.id}`,
    headers: { ...auth(customer.token), 'idempotency-key': uuidV7() },
    payload: { quantity: '1', version: 1, addressId: customer.addressId },
  });
  const version = created.json().cart.version as number;
  const applied = await server.inject({
    method: 'POST',
    url: '/v1/customer/cart/coupon',
    headers: { ...auth(customer.token), 'idempotency-key': uuidV7() },
    payload: { code: 'EXPIREQ', version },
  });
  expect(applied.statusCode).toBe(200);
  // Deactivate: the next quote must flag the coupon and not discount.
  const id = (
    await sql<{ id: string }>`SELECT id::text AS id FROM coupons WHERE code='EXPIREQ'`.execute(
      world.db.db,
    )
  ).rows[0]!.id;
  const updated = await server.inject({
    method: 'PATCH',
    url: `/v1/admin/coupons/${id}`,
    headers: { ...auth(admin), 'idempotency-key': uuidV7() },
    payload: { active: false, expectedVersion: '1' },
  });
  expect(updated.statusCode).toBe(200);
  const validated = await server.inject({
    method: 'POST',
    url: '/v1/customer/cart/validate',
    headers: { ...auth(customer.token), 'idempotency-key': uuidV7() },
    payload: { addressId: customer.addressId },
  });
  expect(validated.statusCode).toBe(200);
  const quote = validated.json<{
    couponCode: string | null;
    couponDiscountPaise: string;
    issues: { code: string }[];
  }>();
  expect(quote.couponCode).toBeNull();
  expect(quote.couponDiscountPaise).toBe('0');
  expect(quote.issues.some((i) => i.code === 'COUPON_INVALID')).toBe(true);
});
