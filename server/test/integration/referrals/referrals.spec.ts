import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { REFERRALS, type Referrals } from '../../../src/modules/referrals/contracts/referrals.js';
import {
  IDENTITY_AUTHORIZER,
  type IdentityAuthorizer,
  type VerifiedIdentity,
} from '../../../src/modules/identity/contracts/identity.js';
import {
  WALLET_SPENDER,
  WALLET_VIEWS,
  type WalletSpender,
  type WalletViews,
} from '../../../src/modules/wallet/contracts/wallet.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import { ORDERS, type OrderOperations } from '../../../src/modules/orders/contracts/orders.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(300000);
let world: P5World,
  app: Awaited<ReturnType<typeof createApplication>>,
  referrals: Referrals,
  identity: IdentityAuthorizer,
  wallet: WalletSpender,
  views: WalletViews,
  carts: CartService,
  checkout: CheckoutOperations,
  orders: OrderOperations,
  code: string;
const newIdentity = (): VerifiedIdentity => {
  const sub = uuidV7();
  return {
    pool: 'CUSTOMER',
    sub,
    tokenUse: 'id',
    groups: [],
    email: `${sub}@example.invalid`,
    emailVerified: true,
    name: 'Friend',
    expiresAt: 9999999999,
  };
};
async function friendWithAddress() {
  const principal = await identity.bootstrap(newIdentity(), code);
  const address = uuidV7();
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default)
    SELECT ${address}::uuid,${principal.userId}::uuid,line1,pincode,contact_name,contact_phone,point,true FROM addresses WHERE id=${world.address}::uuid`.execute(
    world.db.db,
  );
  return { userId: principal.userId, address };
}
beforeAll(async () => {
  world = await createP5World();
  await sql`UPDATE users SET email_verified=true WHERE id=${world.customer}::uuid`.execute(
    world.db.db,
  );
  await sql`UPDATE stores SET accepts_cod=true,hourly_capacity=100 WHERE id=${world.store}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES ('wallet_enabled',true),('subscriptions_enabled',true),('cod_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    world.db.db,
  );
  for (const [key, value] of [
    ['deliveryFeeSlabs', [{ maxOrderValuePaise: null, feePaise: '500' }]],
    ['freeDeliveryThresholdPaise', '1000000'],
    ['handlingFeePaise', '0'],
    ['smallCartThresholdPaise', '0'],
    ['smallCartFeePaise', '0'],
    ['surgeFeePaise', '0'],
  ] as const)
    await sql`INSERT INTO app_config(key,value) VALUES(${key},${JSON.stringify(value)}::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`.execute(
      world.db.db,
    );
  app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      ...(world.services.databaseIamUrl
        ? {
            DATABASE_AUTH: 'iam',
            AWS_REGION: process.env.AWS_REGION,
            DB_ACQUIRE_TIMEOUT_MS: '30000',
          }
        : {}),
    }),
    [{ name: 'test', async check() {} }],
  );
  referrals = app.get(REFERRALS);
  identity = app.get(IDENTITY_AUTHORIZER);
  wallet = app.get(WALLET_SPENDER);
  views = app.get(WALLET_VIEWS);
  carts = app.get(CART_SERVICE);
  checkout = app.get(CHECKOUT);
  orders = app.get(ORDERS);
  code = (await referrals.view(world.customer)).code!;
}, 300000);
afterAll(async () => {
  await app?.close();
  if (world) await closeP5World(world);
}, 300000);

test('verified signup grants one expiring reward, even on a concurrent retry', async () => {
  const friend = newIdentity();
  const [first, second] = await Promise.all([
    identity.bootstrap(friend, code),
    identity.bootstrap(friend, code),
  ]);
  expect(first.userId).toBe(second.userId);
  const rows = await sql<{
    n: string;
    amount: string;
    expiry_matches: boolean;
  }>`SELECT count(*)::text AS n,COALESCE(sum(l.delta_paise),0)::text AS amount,
    bool_and(abs(extract(epoch FROM (c.credit_expires_at-(((c.created_at AT TIME ZONE 'Asia/Kolkata')+interval '1 month') AT TIME ZONE 'Asia/Kolkata'))))<5) AS expiry_matches
    FROM referral_claims c JOIN wallet_ledger l ON l.ref_type='REFERRAL' AND l.ref_id='referral:'||c.id::text WHERE c.friend_id=${first.userId}::uuid`.execute(
    world.db.db,
  );
  expect(rows.rows[0]).toEqual({ n: '1', amount: '1000', expiry_matches: true });
  expect((await referrals.view(first.userId)).freeDeliveryAvailable).toBe(true);
  await expect(
    identity.bootstrap({ ...newIdentity(), emailVerified: false }, code),
  ).rejects.toThrow('EMAIL_NOT_VERIFIED');
  await expect(identity.bootstrap(newIdentity(), '0000000000000000')).rejects.toThrow(
    'INVALID_REFERRAL_CODE',
  );
  const existing = newIdentity();
  await identity.bootstrap(existing);
  await expect(identity.bootstrap(existing, code)).rejects.toThrow('REFERRAL_SIGNUP_ONLY');
}, 300000);

test('regular checkout waives delivery once and cancellation restores the benefit', async () => {
  const friend = await friendWithAddress(),
    variant = await world.variant({ price: 10000n, stock: 10n });
  const cart = await carts.getOrCreateActiveCart(friend.userId, friend.address);
  await carts.putItem(friend.userId, variant.id, '1', { expectedVersion: cart.version });
  const quote = await checkout.quote(friend.userId, { addressId: friend.address });
  expect(quote.quote.referralClaimId).toBeTruthy();
  expect(quote.codAvailable).toBe(true);
  expect(quote.quote.fees.find((fee) => fee.kind === 'DELIVERY')).toBeUndefined();
  const placed = await checkout.place(friend.userId, {
    quoteId: quote.quote.quoteId,
    intentId: quote.intentId,
    method: 'COD',
    idempotencyOperationId: uuidV7(),
  });
  expect(placed.confirmation).toBe('CONFIRMED');
  expect((await referrals.view(friend.userId)).freeDeliveryAvailable).toBe(false);
  await orders.cancel(
    placed.order.orderId,
    { type: 'CUSTOMER', id: friend.userId },
    'test cancellation',
  );
  expect((await referrals.view(friend.userId)).freeDeliveryAvailable).toBe(true);
}, 300000);

test('scheduled checkout applies and consumes the same free delivery entitlement', async () => {
  const friend = await friendWithAddress(),
    variant = await world.variant({ price: 10000n, stock: 10n });
  await wallet.credit({
    userId: friend.userId,
    bucket: 'cash',
    amountPaise: '20000',
    reason: 'TOPUP_CREDIT',
    refType: 'TEST',
    refId: uuidV7(),
  });
  const start = new Date(Date.now() + 86400000),
    end = new Date(start.getTime() + 3600000);
  const input = {
    userId: friend.userId,
    subscriptionId: uuidV7(),
    deliveryDate: start.toISOString().slice(0, 10),
    storeId: world.store,
    addressId: friend.address,
    variantId: variant.id,
    quantity: '1',
    slotStart: start.toISOString(),
    slotEnd: end.toISOString(),
  };
  const placed = await world.db.db
    .transaction()
    .execute((tx) => checkout.placeScheduled(input, tx));
  const order = await orders.byId(placed.orderId, { userId: friend.userId });
  expect(order?.fees.find((fee) => fee.kind === 'DELIVERY')).toBeUndefined();
  expect((await referrals.view(friend.userId)).freeDeliveryAvailable).toBe(false);
}, 300000);

test('a referral credit reversed after expiry cannot become non-expiring', async () => {
  const userId = world.thirdCustomer,
    ref = `referral:${uuidV7()}`,
    spend = uuidV7();
  const expires = new Date(Date.now() + 12000).toISOString();
  await wallet.credit({
    userId,
    bucket: 'promo',
    amountPaise: '1000',
    reason: 'PROMO_GRANT',
    refType: 'REFERRAL',
    refId: ref,
    expiresAt: expires,
  });
  await world.db.db.transaction().execute((tx) => wallet.spend(userId, spend, '1000', tx));
  const wait = Math.max(0, Date.parse(expires) - Date.now() + 300);
  await new Promise((resolve) => setTimeout(resolve, wait));
  await wallet.reverseSpend(spend);
  expect((await views.balances(userId)).promoPaise).toBe('0');
  const rows = await sql<{
    reason: string;
    delta: string;
  }>`SELECT reason,delta_paise::text AS delta FROM wallet_ledger WHERE ref_id=${`cancel:${spend}`} ORDER BY created_at,id`.execute(
    world.db.db,
  );
  expect(rows.rows).toEqual([
    { reason: 'ORDER_PAYMENT_REVERSAL', delta: '1000' },
    { reason: 'PROMO_EXPIRY', delta: '-1000' },
  ]);
  expect(await wallet.reverseSpend(spend)).toBe(false);
}, 300000);

test('expired promotional credit is excluded from wallet balance and checkout before the expiry worker runs', async () => {
  const friend = await friendWithAddress();
  const variant = await world.variant({ price: 10000n, stock: 10n });
  await wallet.credit({
    userId: friend.userId,
    bucket: 'promo',
    amountPaise: '1000',
    reason: 'PROMO_GRANT',
    refType: 'REFERRAL',
    refId: `referral:${uuidV7()}`,
    expiresAt: new Date(Date.now() - 60000).toISOString(),
  });
  expect((await views.balances(friend.userId)).promoPaise).toBe('0');
  const cart = await carts.getOrCreateActiveCart(friend.userId, friend.address);
  await carts.putItem(friend.userId, variant.id, '1', { expectedVersion: cart.version });
  const quote = await checkout.quote(friend.userId, { addressId: friend.address });
  expect(quote.quote.wallet?.promoPaise).toBe('0');
  expect(quote.quote.amountDuePaise).toBe(quote.quote.totalPaise);
}, 300000);

test('checkout reports cash availability from the active backend policy', async () => {
  const friend = await friendWithAddress();
  const variant = await world.variant({ price: 10000n, stock: 10n });
  const cart = await carts.getOrCreateActiveCart(friend.userId, friend.address);
  await carts.putItem(friend.userId, variant.id, '1', { expectedVersion: cart.version });
  await sql`UPDATE feature_flags SET enabled=false WHERE key='cod_enabled'`.execute(world.db.db);
  try {
    expect((await checkout.quote(friend.userId, { addressId: friend.address })).codAvailable).toBe(
      false,
    );
  } finally {
    await sql`UPDATE feature_flags SET enabled=true WHERE key='cod_enabled'`.execute(world.db.db);
  }
  expect((await checkout.quote(friend.userId, { addressId: friend.address })).codAvailable).toBe(
    true,
  );
}, 300000);
