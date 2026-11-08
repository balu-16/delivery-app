import { createHmac } from 'node:crypto';
import { FakeGateway } from '../../../src/adapters/payments/fake-gateway.js';
import {
  GatewayAmbiguousError,
  GatewayRejectedError,
  GatewayTimeoutError,
} from '../../../src/modules/payments/contracts/gateway.js';
import {
  amountToGatewayNumber,
  assertCurrency,
  gatewayAmountPaise,
  nonNegativeAmountPaise,
} from '../../../src/modules/payments/contracts/amounts.js';
import { parseGatewayEvent } from '../../../src/modules/payments/domain/events.js';
import {
  newOperationReference,
  newRefundReference,
  validReference,
} from '../../../src/modules/payments/domain/references.js';
import {
  transitionAttempt,
  transitionRefund,
} from '../../../src/modules/payments/domain/states.js';

describe('fake gateway (deterministic local provider)', () => {
  it('scripts captured creates, failures and unknown timeouts per operation reference', async () => {
    const gateway = new FakeGateway();
    const created = await gateway.createOrder({
      operationReference: 'order-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amountPaise: '50000',
      currency: 'INR',
    });
    expect(created.status).toBe('CREATED');
    expect(created.gatewayOrderId).toMatch(/^order_[0-9a-f]+$/);
    gateway.scriptCreate('order-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'TIMEOUT');
    await expect(
      gateway.createOrder({
        operationReference: 'order-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amountPaise: '50000',
        currency: 'INR',
      }),
    ).rejects.toBeInstanceOf(GatewayTimeoutError);
    gateway.scriptCreate('order-cccccccccccccccccccccccccccccccc', 'REJECTED');
    await expect(
      gateway.createOrder({
        operationReference: 'order-cccccccccccccccccccccccccccccccc',
        amountPaise: '50000',
        currency: 'INR',
      }),
    ).rejects.toBeInstanceOf(GatewayRejectedError);
    // Deterministic: the same reference always produces the same order id.
    const again = await gateway.createOrder({
      operationReference: 'order-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amountPaise: '50000',
      currency: 'INR',
    });
    expect(again.gatewayOrderId).toBe(created.gatewayOrderId);
  });

  it('emits signed captured payment webhooks and records lookups', async () => {
    const gateway = new FakeGateway();
    const emitted = gateway.emitCaptured({ gatewayOrderId: 'order_x1', amountPaise: '25000' });
    const expected = createHmac('sha256', 'fake-webhook-secret').update(emitted.raw).digest('hex');
    expect(emitted.signature).toBe(expected);
    expect(gateway.verifyWebhook(emitted.raw, emitted.signature, 'fake-webhook-secret')).toBe(true);
    expect(gateway.verifyWebhook(emitted.raw, `${expected}00`, 'fake-webhook-secret')).toBe(false);
    expect((await gateway.fetchPayment({ gatewayPaymentId: emitted.paymentId }))?.status).toBe(
      'CAPTURED',
    );
    expect((await gateway.listOrderPayments('order_x1')).length).toBe(1);
    const reference = 'order-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await gateway.createOrder({
      operationReference: reference,
      amountPaise: '1000',
      currency: 'INR',
    });
    const found = await gateway.findOrdersByReceipt(reference);
    expect(found.length).toBe(1);
    expect(found[0]!.amountPaise).toBe('1000');
  });

  it('scripts refunds with processed, pending, failed and timeout outcomes', async () => {
    const gateway = new FakeGateway();
    const processed = await gateway.refund({
      refundReference: 'refund-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      gatewayPaymentId: 'pay_1',
      amountPaise: '1000',
    });
    expect(processed.status).toBe('PROCESSED');
    gateway.scriptRefund('refund-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'PENDING');
    expect(
      (
        await gateway.refund({
          refundReference: 'refund-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          gatewayPaymentId: 'pay_1',
          amountPaise: '1000',
        })
      ).status,
    ).toBe('PENDING');
    gateway.scriptRefund('refund-cccccccccccccccccccccccccccccccc', 'FAILED');
    await expect(
      gateway.refund({
        refundReference: 'refund-cccccccccccccccccccccccccccccccc',
        gatewayPaymentId: 'pay_1',
        amountPaise: '1000',
      }),
    ).rejects.toBeInstanceOf(GatewayRejectedError);
    gateway.scriptRefund('refund-dddddddddddddddddddddddddddddddd', 'TIMEOUT');
    await expect(
      gateway.refund({
        refundReference: 'refund-dddddddddddddddddddddddddddddddd',
        gatewayPaymentId: 'pay_1',
        amountPaise: '1000',
      }),
    ).rejects.toBeInstanceOf(GatewayTimeoutError);
    expect(await gateway.fetchSettlements({ limit: 10 })).toEqual({ items: [], nextCursor: null });
  });
});

describe('gateway boundary money (ADD-01)', () => {
  it('keeps paise as decimal strings and fences unsafe gateway conversions', () => {
    expect(gatewayAmountPaise('49900')).toBe(49900n);
    expect(nonNegativeAmountPaise('0')).toBe(0n);
    expect(amountToGatewayNumber('49900')).toBe(49900);
    expect(() => gatewayAmountPaise('-1')).toThrow('MONEY_OUT_OF_RANGE');
    expect(() => gatewayAmountPaise('4.5')).toThrow('INVALID_MONEY');
    expect(() => amountToGatewayNumber('9007199254740993')).toThrow('UNSAFE_GATEWAY_AMOUNT');
    expect(() => gatewayAmountPaise('9223372036854775808')).toThrow('MONEY_OUT_OF_RANGE');
  });
  it('compares currency before acceptance', () => {
    assertCurrency('INR', 'INR');
    expect(() => assertCurrency('INR', 'USD')).toThrow('AMOUNT_MISMATCH');
    expect(() => assertCurrency('inr', 'INR')).toThrow('INVALID_INPUT');
  });
});

describe('attempt and refund state machines (D18)', () => {
  it('lets a capture supersede a failure but never regress', () => {
    expect(transitionAttempt('FAILED', 'CAPTURED')).toBe('CAPTURED');
    expect(transitionAttempt('UNKNOWN', 'CAPTURED')).toBe('CAPTURED');
    expect(() => transitionAttempt('CAPTURED', 'FAILED')).toThrow();
    expect(() => transitionAttempt('CAPTURED', 'AUTHORIZED')).toThrow();
  });
  it('keeps refund UNKNOWN resolvable only to terminal states', () => {
    expect(transitionRefund('PENDING', 'UNKNOWN')).toBe('UNKNOWN');
    expect(transitionRefund('UNKNOWN', 'PROCESSED')).toBe('PROCESSED');
    expect(transitionRefund('UNKNOWN', 'FAILED')).toBe('FAILED');
    expect(() => transitionRefund('PROCESSED', 'FAILED')).toThrow();
    expect(() => transitionRefund('UNKNOWN', 'PENDING')).toThrow();
  });
});

describe('operation references', () => {
  it('satisfy the documented Razorpay receipt/idempotency constraints', () => {
    const order = newOperationReference('order');
    const topup = newOperationReference('topup');
    const refund = newRefundReference();
    for (const reference of [order, topup, refund]) {
      expect(validReference(reference)).toBe(true);
      expect(reference.length).toBeLessThanOrEqual(40);
      expect(reference.length).toBeGreaterThanOrEqual(10);
      expect(reference).toMatch(/^[a-z][a-z0-9-]+$/);
    }
    expect(validReference('short')).toBe(false);
    expect(validReference('UPPER_CASE')).toBe(false);
  });
});

describe('webhook payload parsing', () => {
  const paymentEntity = {
    id: 'pay_G8PA8ZOhUfRdIV',
    entity: 'payment',
    order_id: 'order_G8P7m8',
    amount: 29900,
    currency: 'INR',
    status: 'captured',
  };
  it('parses documented payment.captured payloads', () => {
    const parsed = parseGatewayEvent(
      JSON.stringify({
        event: 'payment.captured',
        contains: ['payment'],
        payload: { payment: { entity: paymentEntity } },
      }),
    );
    expect(parsed).toEqual({
      kind: 'ok',
      event: {
        type: 'payment.captured',
        payment: {
          paymentId: 'pay_G8PA8ZOhUfRdIV',
          gatewayOrderId: 'order_G8P7m8',
          amountPaise: '29900',
          currency: 'INR',
          status: 'captured',
        },
        refund: null,
      },
    });
  });
  it('parses refund.processed payloads with the payment reference', () => {
    const parsed = parseGatewayEvent(
      JSON.stringify({
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_1',
              entity: 'refund',
              payment_id: 'pay_1',
              amount: 500,
              status: 'processed',
            },
          },
        },
      }),
    );
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') {
      expect(parsed.event.refund).toEqual({
        refundId: 'rfnd_1',
        gatewayPaymentId: 'pay_1',
        amountPaise: '500',
        status: 'processed',
      });
      expect(parsed.event.type).toBe('refund.processed');
    }
  });
  it('maps order.paid to the payment entity and unknown events to UNMAPPED', () => {
    const paid = parseGatewayEvent(
      JSON.stringify({ event: 'order.paid', payload: { payment: { entity: paymentEntity } } }),
    );
    expect(paid.kind === 'ok' && paid.event.type).toBe('order.paid');
    const unknown = parseGatewayEvent(
      JSON.stringify({
        event: 'payout.processed',
        payload: { payout: { entity: { id: 'po_1' } } },
      }),
    );
    expect(unknown.kind === 'ok' && unknown.event.type).toBe('UNMAPPED');
  });
  it('quarantines unparseable bodies instead of guessing', () => {
    expect(parseGatewayEvent('not json').kind).toBe('unparseable');
    expect(parseGatewayEvent('[]').kind).toBe('unparseable');
    expect(parseGatewayEvent(JSON.stringify({ event: 'payment.captured' })).kind).toBe(
      'unparseable',
    );
    expect(parseGatewayEvent(JSON.stringify({ event: 'payment.captured', payload: {} })).kind).toBe(
      'unparseable',
    );
  });
  it('rejects ambiguous outcomes as GatewayAmbiguousError instances', () => {
    const error = new GatewayAmbiguousError('unreadable');
    expect(error.code).toBe('GATEWAY_OUTCOME_UNKNOWN');
    expect(error instanceof Error).toBe(true);
  });
});
