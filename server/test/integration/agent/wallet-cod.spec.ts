import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { CART_SERVICE, type CartService } from '../../../src/modules/cart/contracts/cart.js';
import {
  CHECKOUT,
  type CheckoutOperations,
} from '../../../src/modules/checkout/contracts/checkout.js';
import {
  WALLET_SPENDER,
  type WalletSpender,
} from '../../../src/modules/wallet/contracts/wallet.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;

beforeAll(async () => {
  world = await createP5World();
  await sql`INSERT INTO feature_flags(key,enabled) VALUES ('wallet_enabled',true),('cod_enabled',true)
    ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(world.db.db);
  await sql`UPDATE stores SET accepts_cod=true WHERE id=${world.store}::uuid`.execute(world.db.db);
  for (const [key, value] of [
    ['deliveryFeeSlabs', [{ maxOrderValuePaise: null, feePaise: '0' }]],
    ['freeDeliveryThresholdPaise', '0'],
    ['handlingFeePaise', '0'],
    ['smallCartThresholdPaise', '0'],
    ['smallCartFeePaise', '0'],
    ['surgeFeePaise', '0'],
  ] as const) {
    await sql`INSERT INTO app_config(key,value) VALUES(${key},${JSON.stringify(value)}::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=app_config.version+1`.execute(
      world.db.db,
    );
  }
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'customer',
    LOG_LEVEL: 'silent',
    DATABASE_URL: world.services.databaseUrl,
    REDIS_URL: world.services.redisUrl,
  });
  app = await createApplication(env, [{ name: 'test', async check() {} }]);
}, 300000);

afterAll(async () => {
  await app?.close();
  if (world) await closeP5World(world);
}, 300000);

test('a ₹100 COD order uses ₹50 of existing wallet funds exactly once', async () => {
  const wallet = app.get<WalletSpender>(WALLET_SPENDER);
  await wallet.credit({
    userId: world.customer,
    bucket: 'cash',
    amountPaise: '5000',
    reason: 'ADMIN_ADJUSTMENT',
    refType: 'TEST',
    refId: uuidV7(),
  });
  const variant = await world.variant({ price: 10000n, stock: 10n, gstRateBps: 0 });
  const cartService = app.get<CartService>(CART_SERVICE);
  const cart = await cartService.getOrCreateActiveCart(world.customer, world.address);
  await cartService.putItem(world.customer, variant.id, '1', { expectedVersion: cart.version });
  const checkout = app.get<CheckoutOperations>(CHECKOUT);
  const quoted = await checkout.quote(world.customer, { addressId: world.address });
  expect(quoted.codAvailable).toBe(true);
  expect(quoted.quote.totalPaise).toBe('10000');
  expect(quoted.quote.wallet?.cashPaise).toBe('5000');
  expect(quoted.quote.amountDuePaise).toBe('5000');

  const input = {
    quoteId: quoted.quote.quoteId,
    intentId: quoted.intentId,
    method: 'COD' as const,
    idempotencyOperationId: uuidV7(),
  };
  const placed = await checkout.place(world.customer, input);
  const retried = await checkout.place(world.customer, input);
  expect(retried.order.orderId).toBe(placed.order.orderId);
  const result = await sql<{
    method: string;
    due: string;
    wallet: string;
    balance: string;
    debits: string;
  }>`SELECT
    o.payment_method AS method,o.amount_due_paise::text AS due,o.wallet_cash_paise::text AS wallet,
    a.cash_balance_paise::text AS balance,
    (SELECT count(*)::text FROM wallet_ledger l WHERE l.account_id=a.id AND l.reason='ORDER_PAYMENT' AND l.ref_id=o.id::text) AS debits
    FROM orders o JOIN wallet_accounts a ON a.user_id=o.user_id WHERE o.id=${placed.order.orderId}::uuid`.execute(
    world.db.db,
  );
  expect(result.rows[0]).toEqual({
    method: 'COD',
    due: '5000',
    wallet: '5000',
    balance: '0',
    debits: '1',
  });
}, 120000);
