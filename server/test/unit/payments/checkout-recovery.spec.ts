import 'reflect-metadata';
import { jest } from '@jest/globals';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import { PostgresQueryCompiler, createQueryId, type CompiledQuery } from 'kysely';
import { AUTH_POLICY } from '../../../src/modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../src/modules/identity/contracts/identity-guard.js';
import type { CheckoutPlaceResult } from '../../../src/modules/checkout/contracts/checkout.js';
import { CheckoutService } from '../../../src/modules/checkout/infrastructure/checkout-service.js';
import { isDefinitivePlacementError } from '../../../src/modules/checkout/contracts/checkout.js';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { PostgresCartService } from '../../../src/modules/cart/infrastructure/postgres-carts.js';
import { PlaceOrderSaga } from '../../../src/modules/checkout/infrastructure/place-order.js';
import { IdempotencyStore } from '../../../src/common/idempotency/idempotency.js';
import type { Database } from '../../../src/platform/database/database.js';
import { CustomerCheckoutController } from '../../../src/surfaces/customer/checkout/customer.controller.js';
import { fakeDatabase } from '../helpers/fake-db.js';

function serviceWithRows(rows: unknown[]) {
  const queries: CompiledQuery[] = [];
  const compiler = new PostgresQueryCompiler();
  const executor = {
    transformQuery: (query: Parameters<PostgresQueryCompiler['compileQuery']>[0]) => query,
    compileQuery: (query: Parameters<PostgresQueryCompiler['compileQuery']>[0]) =>
      compiler.compileQuery(query, createQueryId()),
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      return { rows };
    },
  };
  const db = { getExecutor: () => executor } as unknown as Database;
  return { service: new CheckoutService(db, {} as never, {} as never), queries };
}

test('placement lookup scopes both the claim and order to the customer without logging the key', async () => {
  const { service, queries } = serviceWithRows([
    {
      state: 'PROCESSING',
      live: true,
      order_id: 'order-id',
      order_number: 'ORDER-1',
      order_status: 'PICKING',
      payment_status: 'COD_PENDING',
    },
  ]);
  const key = "private-key-'--";
  await expect(service.placementStatus('customer-id', key)).resolves.toEqual({
    state: 'ORDER_FOUND',
    order: {
      orderId: 'order-id',
      orderNumber: 'ORDER-1',
      status: 'PICKING',
      paymentStatus: 'COD_PENDING',
    },
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.parameters).toEqual(['customer-id', 'customer-id', key]);
  expect(queries[0]!.sql).toContain('user_id=$1::uuid');
  expect(queries[0]!.sql).toContain('i.actor=$2');
  expect(queries[0]!.sql).toContain("i.resource='/v1/customer/checkout/place'");
  expect(queries[0]!.sql).not.toContain(key);
});

test.each([
  [[], 'UNKNOWN'],
  [[{ state: 'PROCESSING', live: true }], 'PROCESSING'],
  [[{ state: 'PROCESSING', live: false }], 'UNKNOWN'],
  [[{ state: 'COMPLETED', live: false }], 'UNKNOWN'],
] as const)(
  'never guesses an order outcome without a matching committed order',
  async (rows, state) => {
    const { service } = serviceWithRows([...rows]);
    await expect(service.placementStatus('customer-id', 'same-key')).resolves.toEqual({ state });
  },
);

test('status route retains authentication, no-store and validates the key', async () => {
  const placementStatus = jest.fn(async () => ({ state: 'UNKNOWN' as const }));
  const controller = new CustomerCheckoutController(
    { placementStatus } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  expect(Reflect.getMetadata(AUTH_POLICY, CustomerCheckoutController)).toMatchObject({
    audience: 'customer',
  });
  expect(Reflect.getMetadata(GUARDS_METADATA, CustomerCheckoutController)).toContain(IdentityGuard);
  expect(
    Reflect.getMetadata(HEADERS_METADATA, CustomerCheckoutController.prototype.placementStatus),
  ).toEqual(expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]));
  expect(() => controller.placementStatus({ userId: 'customer' } as never, undefined)).toThrow();
  expect(() =>
    controller.placementStatus({ userId: 'customer' } as never, 'x'.repeat(151)),
  ).toThrow();
  await expect(
    controller.placementStatus({ userId: 'customer' } as never, 'same-key'),
  ).resolves.toEqual({ state: 'UNKNOWN' });
  expect(placementStatus).toHaveBeenCalledWith('customer', 'same-key');
});

test.each(['in_progress', 'response_expired'] as const)(
  'the same request recovers a committed order when its claim is %s',
  async (kind) => {
    const committed = {
      order: { orderId: 'order', status: 'PICKING' },
      payment: null,
      confirmation: 'CONFIRMED',
    } as unknown as CheckoutPlaceResult;
    const recoverCommitted = jest.fn(async () => committed);
    const place = jest.fn(async () => committed);
    const claim = jest.fn(async () => ({ kind, operationId: 'operation' }));
    const controller = new CustomerCheckoutController(
      { recoverCommitted, place } as never,
      {} as never,
      {} as never,
      {} as never,
      { claim } as never,
    );
    await expect(
      controller.place(
        { userId: 'customer' } as never,
        { quoteId: 'quote', intentId: 'intent', method: 'COD' },
        'original-key',
      ),
    ).resolves.toEqual(committed);
    expect(recoverCommitted).toHaveBeenCalledWith('customer', 'operation');
    expect(place).not.toHaveBeenCalled();
  },
);

test('an unresolved or changed request cannot recover or execute another order', async () => {
  const recoverCommitted = jest.fn(async () => null);
  const place = jest.fn();
  const claim = jest
    .fn<() => Promise<{ kind: 'in_progress'; operationId: string } | { kind: 'key_reused' }>>()
    .mockResolvedValueOnce({ kind: 'in_progress', operationId: 'operation' })
    .mockResolvedValueOnce({ kind: 'key_reused' });
  const controller = new CustomerCheckoutController(
    { recoverCommitted, place } as never,
    {} as never,
    {} as never,
    {} as never,
    { claim } as never,
  );
  const request = { quoteId: 'quote', intentId: 'intent', method: 'COD' as const };
  await expect(
    controller.place({ userId: 'customer' } as never, request, 'key'),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'REQUEST_IN_PROGRESS' },
  });
  await expect(
    controller.place({ userId: 'customer' } as never, request, 'key'),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'IDEMPOTENCY_KEY_REUSED' },
  });
  expect(recoverCommitted).toHaveBeenCalledTimes(1);
  expect(place).not.toHaveBeenCalled();
});

test.each([
  ['PENDING_PAYMENT', 'PENDING_PAYMENT'],
  ['CONFIRMED', 'CONFIRMED'],
  ['PICKING', 'CONFIRMED'],
  ['DELIVERED', 'CONFIRMED'],
  ['CANCELLED', 'ORDER_CLOSED'],
  ['EXPIRED', 'ORDER_CLOSED'],
  ['PAYMENT_FAILED', 'ORDER_CLOSED'],
] as const)(
  'read-only recovery preserves %s lifecycle without calling the payment gateway',
  async (status, confirmation) => {
    const completeSetup = jest.fn();
    const service = new CheckoutService(
      {} as never,
      { paymentOrders: { listAttempts: async () => [], completeSetup } } as never,
      {} as never,
    );
    Object.defineProperty(service, 'saga', {
      value: { findResumable: async () => ({ userId: 'customer', orderId: 'order', status }) },
    });
    await expect(service.recoverCommitted('customer', 'operation')).resolves.toMatchObject({
      order: { status },
      confirmation,
      payment: null,
    });
    expect(completeSetup).not.toHaveBeenCalled();
    await expect(service.recoverCommitted('another-customer', 'operation')).resolves.toBeNull();
  },
);

test('transactional config reads hold the shared side of the 701001 lock', async () => {
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes('pg_advisory_xact_lock_shared(701001)')) return { rows: [] };
    if (query.sql.includes('FROM app_config')) {
      return { rows: [{ key: 'minOrderPaise', value: '0', version: '1' }] };
    }
    return { rows: [] };
  });
  const config = new ConfigService(db);
  const tx = { getExecutor: () => db.getExecutor() } as never;
  await expect(config.getMany(['minOrderPaise'], tx)).resolves.toEqual({
    minOrderPaise: '0',
  });
  expect(queries[0]!.sql).toContain('pg_advisory_xact_lock_shared(701001)');
  expect(queries).toHaveLength(2);
  expect(queries[1]!.sql).toContain('FROM app_config');
});

test('non-transactional config reads take no advisory lock', async () => {
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes('FROM app_config')) {
      return { rows: [{ key: 'minOrderPaise', value: '0', version: '1' }] };
    }
    return { rows: [] };
  });
  const config = new ConfigService(db);
  await expect(config.getMany(['minOrderPaise'])).resolves.toEqual({ minOrderPaise: '0' });
  expect(queries.some((query) => query.sql.includes('pg_advisory'))).toBe(false);
});

test('cart writes take the cart advisory lock before reading config', async () => {
  const events: string[] = [];
  const { db } = fakeDatabase((query) => {
    events.push(query.sql.includes('pg_advisory_xact_lock') ? 'advisory' : 'query');
    if (query.sql.includes('FROM carts WHERE user_id'))
      return {
        rows: [
          {
            id: 'c1',
            user_id: 'u1',
            store_id: 's1',
            address_id: 'a1',
            coupon_code: null,
            version: '1',
          },
        ],
      };
    if (query.sql.includes('FROM catalog_global_prices p JOIN catalog_variants'))
      return {
        rows: [
          {
            selling_paise: '100',
            mrp_paise: '120',
            gst_rate_bps: 0,
            existing_quantity: null,
            existing_unit_price: null,
            line_count: '0',
          },
        ],
      };
    if (query.sql.includes('UPDATE carts SET version=version+1'))
      return {
        rows: [
          {
            id: 'c1',
            user_id: 'u1',
            store_id: 's1',
            address_id: 'a1',
            coupon_code: null,
            version: '2',
          },
        ],
      };
    if (query.sql.includes('FROM cart_items ci')) return { rows: [] };
    return { rows: [] };
  });
  const config = {
    getMany: async () => {
      events.push('config');
      return { catalogMaxPerOrder: 10, maxCartLines: 50 };
    },
  } as never;
  const carts = new PostgresCartService(db, config, {} as never);
  await carts.putItem('u1', 'v1', '1', { expectedVersion: 1 });
  expect(events[0]).toBe('advisory');
  expect(events.indexOf('config')).toBeGreaterThan(0);
  expect(events.indexOf('config')).toBeLessThan(events.lastIndexOf('query'));
});

test('a recorded rejection reports REJECTED, but a committed order still wins', async () => {
  const rejected = serviceWithRows([
    { state: 'COMPLETED', live: false, rejection_code: 'QUOTE_EXPIRED' },
  ]);
  await expect(rejected.service.placementStatus('customer-id', 'same-key')).resolves.toEqual({
    state: 'REJECTED',
    code: 'QUOTE_EXPIRED',
  });
  expect(rejected.queries[0]!.sql).toContain('i.rejection_code');
  const raced = serviceWithRows([
    {
      state: 'COMPLETED',
      live: false,
      rejection_code: 'QUOTE_EXPIRED',
      order_id: 'order-id',
      order_number: 'ORDER-1',
      order_status: 'CONFIRMED',
      payment_status: 'COD_PENDING',
    },
  ]);
  await expect(raced.service.placementStatus('customer-id', 'same-key')).resolves.toMatchObject({
    state: 'ORDER_FOUND',
  });
});

test('only terminal-for-body failures are definitive; ambiguity stays unknown', () => {
  for (const code of [
    'COD_NOT_ELIGIBLE',
    'COD_LIMIT_EXCEEDED',
    'PRICE_CHANGED',
    'QUOTE_EXPIRED',
    'QUOTE_CONSUMED',
    'CART_INTENT_CONSUMED',
    'CONCURRENT_MODIFICATION',
    'INVENTORY_INSUFFICIENT',
    'ITEM_UNAVAILABLE',
    'ADDRESS_NOT_SERVICEABLE',
    'ADDRESS_LOCATION_REQUIRED',
    'CART_NOT_FOUND',
    'WALLET_INSUFFICIENT',
    'WALLET_DISABLED',
    'COUPON_INVALID',
    'MIN_ORDER_NOT_MET',
    'MAX_ORDER_EXCEEDED',
  ])
    expect(isDefinitivePlacementError(new Error(code))).toBe(true);
  for (const error of [
    new Error('IDEMPOTENCY_LEASE_LOST'),
    new Error('REQUEST_IN_PROGRESS'),
    new Error('ONLINE_PAYMENTS_NOT_READY'),
    new Error('RESOURCE_CONFLICT'),
    new Error('INTERNAL_ERROR'),
    new TypeError('network'),
    'QUOTE_EXPIRED',
  ])
    expect(isDefinitivePlacementError(error)).toBe(false);
});

test('a rejected claim throws its recorded code; an error replay never returns a body', async () => {
  const claim = jest
    .fn<
      () => Promise<
        | { kind: 'rejected'; operationId: string; status: number; code: string }
        | { kind: 'replay'; operationId: string; status: number; body: unknown }
      >
    >()
    .mockResolvedValueOnce({
      kind: 'rejected',
      operationId: 'op',
      status: 409,
      code: 'QUOTE_EXPIRED',
    })
    .mockResolvedValueOnce({
      kind: 'replay',
      operationId: 'op',
      status: 409,
      body: { code: 'PRICE_CHANGED' },
    })
    .mockResolvedValueOnce({ kind: 'replay', operationId: 'op', status: 200, body: { ok: true } });
  const controller = new CustomerCheckoutController(
    { recoverCommitted: async () => null, place: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { claim } as never,
  );
  const request = { quoteId: 'quote', intentId: 'intent', method: 'COD' as const };
  await expect(
    controller.place({ userId: 'customer' } as never, request, 'key'),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'QUOTE_EXPIRED' },
  });
  await expect(
    controller.place({ userId: 'customer' } as never, request, 'key'),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'PRICE_CHANGED' },
  });
  await expect(controller.place({ userId: 'customer' } as never, request, 'key')).resolves.toEqual({
    ok: true,
  });
});

test('a failed placement settles through recovery before rethrowing', async () => {
  const recovered = { order: { orderId: 'order' } } as unknown as CheckoutPlaceResult;
  const failure = new Error('PRICE_CHANGED');
  const place = jest.fn(async () => {
    throw failure;
  });
  const settleFailedPlacement = jest
    .fn<
      (
        userId: string,
        owner: unknown,
        input: unknown,
        error: unknown,
      ) => Promise<CheckoutPlaceResult | null>
    >()
    .mockResolvedValueOnce(recovered)
    .mockResolvedValueOnce(null);
  const claim = jest.fn(async () => ({
    kind: 'claimed' as const,
    owner: { scope: { actor: 'customer' }, token: 'token', operationId: 'operation' },
  }));
  const execute = jest.fn(async (_owner: unknown, work: (tx: never) => Promise<unknown>) =>
    work({} as never),
  );
  const controller = new CustomerCheckoutController(
    { recoverCommitted: async () => null, place, settleFailedPlacement } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      claim,
      execute,
      withRenewal: async (_owner: unknown, work: () => Promise<unknown>) => work(),
    } as never,
  );
  const request = { quoteId: 'quote', intentId: 'intent', method: 'COD' as const };
  await expect(controller.place({ userId: 'customer' } as never, request, 'key')).resolves.toBe(
    recovered,
  );
  expect(settleFailedPlacement).toHaveBeenCalledWith(
    'customer',
    expect.objectContaining({ operationId: 'operation' }),
    { intentId: 'intent' },
    failure,
  );
  await expect(controller.place({ userId: 'customer' } as never, request, 'key')).rejects.toBe(
    failure,
  );
  expect(place).toHaveBeenCalledTimes(2);
});

test('settle records only fenced definitive failures and recovers committed orders', async () => {
  const owner = {
    scope: {
      actor: 'customer',
      audience: 'customer',
      method: 'POST',
      resource: '/v1/customer/checkout/place',
      key: 'key',
    },
    token: 'token',
    operationId: 'operation',
  } as never;
  const keyRow = {
    request_hash: 'h',
    canonical_request_hash: null,
    operation_id: 'operation',
    state: 'PROCESSING',
    owner_token: 'token',
    lease_until: new Date(Date.now() + 60000),
    response_status: null,
    response_body: null,
    rejection_code: null,
    rejection_status: null,
  };
  const recorded: string[] = [];
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes('UPDATE idempotency_keys SET state=')) {
      recorded.push(query.sql);
      return { rows: [], numAffectedRows: 1 };
    }
    if (query.sql.includes('FROM idempotency_keys')) return { rows: [{ ...keyRow }] };
    if (query.sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  });
  const service = new CheckoutService(
    db,
    { paymentOrders: { listAttempts: async () => [] } } as never,
    {} as never,
  );
  Object.defineProperty(service, 'saga', {
    value: { findResumable: async () => null, findByIntent: async () => null },
  });
  // Ambiguous failures never touch the key row.
  await expect(
    service.settleFailedPlacement(
      'customer',
      owner,
      { intentId: 'intent' },
      new Error('IDEMPOTENCY_LEASE_LOST'),
    ),
  ).resolves.toBeNull();
  expect(queries).toHaveLength(0);
  // Definitive failures with no order record a rejection and rethrow via null.
  await expect(
    service.settleFailedPlacement(
      'customer',
      owner,
      { intentId: 'intent' },
      new Error('QUOTE_EXPIRED'),
    ),
  ).resolves.toBeNull();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toContain("state='COMPLETED'");
  expect(recorded[0]).toContain('rejection_code');
  // An order under the operation recovers instead of recording.
  const order = { userId: 'customer', orderId: 'order', status: 'CONFIRMED' };
  Object.defineProperty(service, 'saga', {
    value: { findResumable: async () => order, findByIntent: async () => null },
  });
  await expect(
    service.settleFailedPlacement(
      'customer',
      owner,
      { intentId: 'intent' },
      new Error('QUOTE_EXPIRED'),
    ),
  ).resolves.toMatchObject({ order });
  expect(recorded).toHaveLength(1);
  // An order under the same intent (another key) recovers instead of recording.
  Object.defineProperty(service, 'saga', {
    value: { findResumable: async () => null, findByIntent: async () => order },
  });
  await expect(
    service.settleFailedPlacement(
      'customer',
      owner,
      { intentId: 'intent' },
      new Error('QUOTE_CONSUMED'),
    ),
  ).resolves.toMatchObject({ order });
  expect(recorded).toHaveLength(1);
});

test('rejection writes require a live fenced lease and a proven absence', async () => {
  const owner = {
    scope: { actor: 'a', audience: 'customer', method: 'POST', resource: 'r', key: 'k' },
    token: 'token',
    operationId: 'operation',
  } as never;
  const live = {
    request_hash: 'h',
    canonical_request_hash: null,
    operation_id: 'operation',
    state: 'PROCESSING',
    owner_token: 'token',
    lease_until: new Date(Date.now() + 60000),
    response_status: null,
    response_body: null,
    rejection_code: null,
    rejection_status: null,
  };
  const run = async (row: object | null, absent: boolean) => {
    let updates = 0;
    const { db } = fakeDatabase((query) => {
      if (query.sql.includes('UPDATE idempotency_keys SET state=')) {
        updates += 1;
        return { rows: [], numAffectedRows: 1 };
      }
      if (query.sql.includes('FROM idempotency_keys')) return { rows: row ? [{ ...row }] : [] };
      if (query.sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
      return { rows: [] };
    });
    const store = new IdempotencyStore(db);
    const recorded = await store.recordRejection(
      owner,
      { status: 409, code: 'QUOTE_EXPIRED' },
      async () => absent,
    );
    return { recorded, updates };
  };
  await expect(run(live, true)).resolves.toEqual({ recorded: true, updates: 1 });
  await expect(run({ ...live, owner_token: 'stolen' }, true)).resolves.toEqual({
    recorded: false,
    updates: 0,
  });
  await expect(run({ ...live, lease_until: new Date(Date.now() - 1000) }, true)).resolves.toEqual({
    recorded: false,
    updates: 0,
  });
  await expect(run({ ...live, state: 'COMPLETED' }, true)).resolves.toEqual({
    recorded: false,
    updates: 0,
  });
  await expect(run(live, false)).resolves.toEqual({ recorded: false, updates: 0 });
  await expect(run(null, true)).resolves.toEqual({ recorded: false, updates: 0 });
  const { db } = fakeDatabase(() => ({ rows: [] }));
  await expect(
    new IdempotencyStore(db).recordRejection(
      owner,
      { status: 200, code: 'QUOTE_EXPIRED' },
      async () => true,
    ),
  ).rejects.toThrow('INVALID_REJECTION');
  await expect(
    new IdempotencyStore(db).recordRejection(
      owner,
      { status: 409, code: 'nope!' },
      async () => true,
    ),
  ).rejects.toThrow('INVALID_REJECTION');
});

test('a pruned rejection still claims as rejected instead of response_expired', async () => {
  const hash = 'a'.repeat(64);
  const { db } = fakeDatabase((query) => {
    if (query.sql.startsWith('INSERT INTO idempotency_keys')) return { rows: [] };
    if (query.sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
    if (query.sql.includes('AS live'))
      return {
        rows: [
          {
            request_hash: hash,
            canonical_request_hash: null,
            operation_id: 'operation',
            state: 'COMPLETED',
            live: false,
          },
        ],
      };
    if (query.sql.includes('FOR UPDATE'))
      return {
        rows: [
          {
            request_hash: hash,
            canonical_request_hash: null,
            operation_id: 'operation',
            state: 'COMPLETED',
            owner_token: null,
            lease_until: null,
            response_status: null,
            response_body: null,
            rejection_code: 'WALLET_INSUFFICIENT',
            rejection_status: 409,
          },
        ],
      };
    return { rows: [] };
  });
  const store = new IdempotencyStore(db);
  await expect(
    store.claim(
      { actor: 'a', audience: 'customer', method: 'POST', resource: 'r', key: 'k' },
      hash,
      30,
    ),
  ).resolves.toEqual({
    kind: 'rejected',
    operationId: 'operation',
    status: 409,
    code: 'WALLET_INSUFFICIENT',
  });
});

test('intent orders resolve to the same user only', async () => {
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes("metadata->>'intentId'")) return { rows: [{ id: 'order-id' }] };
    return { rows: [] };
  });
  const byId = jest.fn(async () => ({ orderId: 'order-id' }));
  const saga = new PlaceOrderSaga({ db, orders: { byId } } as never);
  await expect(saga.findByIntent('customer', 'intent')).resolves.toEqual({ orderId: 'order-id' });
  expect(queries[0]!.parameters).toEqual(['customer', 'intent']);
  expect(queries[0]!.sql).toContain('user_id=$1::uuid');
  expect(byId).toHaveBeenCalledWith('order-id', { tx: undefined });
  const empty = fakeDatabase(() => ({ rows: [] }));
  const missing = new PlaceOrderSaga({ db: empty.db, orders: { byId } } as never);
  await expect(missing.findByIntent('customer', 'intent')).resolves.toBeNull();
});
