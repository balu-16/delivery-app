import 'reflect-metadata';
import { jest } from '@jest/globals';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import { PostgresQueryCompiler, createQueryId, type CompiledQuery } from 'kysely';
import { AUTH_POLICY } from '../../../src/modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../src/modules/identity/contracts/identity-guard.js';
import type { CheckoutPlaceResult } from '../../../src/modules/checkout/contracts/checkout.js';
import { CheckoutService } from '../../../src/modules/checkout/infrastructure/checkout-service.js';
import type { Database } from '../../../src/platform/database/database.js';
import { CustomerCheckoutController } from '../../../src/surfaces/customer/checkout/customer.controller.js';

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
