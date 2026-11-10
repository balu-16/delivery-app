import { createHmac } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { RazorpayGateway } from '../../../src/adapters/payments/razorpay.js';
import {
  GatewayAmbiguousError,
  GatewayRejectedError,
  GatewayTimeoutError,
  GatewayUnavailableError,
} from '../../../src/modules/payments/contracts/gateway.js';

/**
 * Razorpay adapter CONTRACT FIXTURES (not live acceptance; ADR 0007 and
 * IMPLEMENTATION_PLAN 8.1 "Keep contract fixtures sanitized and versioned with
 * their official source URL"). The local fixture server replicates only
 * documented behavior from, all retrieved 2026-11-06:
 * - Orders API: https://razorpay.com/docs/api/orders/ and
 *   https://razorpay.com/docs/build/llm-docs/api/orders/create.md,
 *   .../api/orders/fetch-all.md, .../api/orders/fetch-payments.md
 * - Payments: https://razorpay.com/docs/api/payments/
 * - Refunds + X-Refund-Idempotency: https://razorpay.com/docs/api/refunds/ and
 *   https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/
 * - Webhook signatures: https://razorpay.com/docs/webhooks/validate-test/
 * - Checkout signature:
 *   https://razorpay.com/docs/developer-tools/integrations/standard-checkout
 *   (re-verified 2026-11-07: HMAC_SHA256(order_id + "|" + payment_id, key_secret))
 * - Settlements: https://razorpay.com/docs/api/settlements/
 * No undocumented behavior is asserted; live-provider acceptance remains an
 * owner-run step with real credentials.
 */
interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  refundIdempotency: string | null;
  body: string;
}
type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

async function startFixture(handlers: Record<string, Handler>): Promise<{
  server: Server;
  url: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const key = `${request.method} ${request.url?.split('?')[0]}`;
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization ?? null,
        refundIdempotency: (request.headers['x-refund-idempotency'] as string | undefined) ?? null,
        body,
      });
      const handler = handlers[key];
      if (!handler) {
        response.statusCode = 404;
        response.end(
          JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'unknown fixture' } }),
        );
        return;
      }
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  openServers.push(server);
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}
function json(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}
const openServers: Server[] = [];
afterEach(async () => {
  // Failed assertions must not leak listening sockets: close every fixture
  // started during the test so Jest can exit deterministically.
  const servers = openServers.splice(0, openServers.length);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const CONFIG = {
  keyId: 'rzp_live_unitfixture',
  keySecret: 'unitfixturesecret',
  webhookSecret: 'unitfixturewebhooksecret',
  // Payload/authentication contracts must tolerate local fixture scheduling and
  // first-fetch initialization. The timeout-specific case sets its own deadline.
  timeoutMs: 2000,
};

describe('Razorpay adapter contract fixtures (documented endpoints only)', () => {
  it('creates orders with basic auth, amount in paise, receipt and notes', async () => {
    const fixture = await startFixture({
      'POST /v1/orders': (request, response) => {
        expect(request.headers.authorization).toBe(
          `Basic ${Buffer.from(`${CONFIG.keyId}:${CONFIG.keySecret}`).toString('base64')}`,
        );
        void request;
        json(response, 201, {
          id: 'order_RB58MiP5SPFYyM',
          entity: 'order',
          amount: 29900,
          amount_paid: 0,
          amount_due: 29900,
          currency: 'INR',
          receipt: 'order-abc',
          status: 'created',
          attempts: 0,
        });
      },
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    const created = await gateway.createOrder({
      operationReference: 'order-abc',
      amountPaise: '29900',
      currency: 'INR',
    });
    expect(created).toEqual({ gatewayOrderId: 'order_RB58MiP5SPFYyM', status: 'CREATED' });
    expect(JSON.parse(fixture.requests[0]!.body)).toEqual({
      amount: 29900,
      currency: 'INR',
      receipt: 'order-abc',
      notes: { operation_reference: 'order-abc' },
    });
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it('recovers a lost create response through the documented receipt lookup, never a second create', async () => {
    let createCalls = 0;
    const fixture = await startFixture({
      'POST /v1/orders': (_request, response) => {
        createCalls += 1;
        response.destroy(); // simulate a lost response after the provider accepted
      },
      'GET /v1/orders': (_request, response) => {
        json(response, 200, {
          entity: 'collection',
          count: 1,
          items: [
            {
              id: 'order_RB58MiP5SPFYyM',
              entity: 'order',
              amount: 29900,
              currency: 'INR',
              receipt: 'order-lost-ref',
              status: 'created',
            },
          ],
        });
      },
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    await expect(
      gateway.createOrder({
        operationReference: 'order-lost-ref',
        amountPaise: '29900',
        currency: 'INR',
      }),
    ).rejects.toBeInstanceOf(GatewayTimeoutError);
    const matches = await gateway.findOrdersByReceipt('order-lost-ref');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.gatewayOrderId).toBe('order_RB58MiP5SPFYyM');
    expect(createCalls).toBe(1);
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it('fetches payments for an order and maps documented statuses', async () => {
    const fixture = await startFixture({
      'GET /v1/orders/order_1/payments': (_request, response) => {
        json(response, 200, {
          entity: 'collection',
          count: 2,
          items: [
            {
              id: 'pay_1',
              entity: 'payment',
              order_id: 'order_1',
              amount: 29900,
              currency: 'INR',
              status: 'captured',
            },
            {
              id: 'pay_2',
              entity: 'payment',
              order_id: 'order_1',
              amount: 29900,
              currency: 'INR',
              status: 'failed',
            },
          ],
        });
      },
      // Documented single-payment fetch used by the verify hint (GET /v1/payments/{id}).
      'GET /v1/payments/pay_1': (_request, response) => {
        json(response, 200, {
          id: 'pay_1',
          entity: 'payment',
          order_id: 'order_1',
          amount: 29900,
          currency: 'INR',
          status: 'captured',
        });
      },
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    const payments = await gateway.listOrderPayments('order_1');
    expect(payments.map((payment) => payment.status)).toEqual(['CAPTURED', 'FAILED']);
    expect(payments[0]!.amountPaise).toBe('29900');
    expect((await gateway.fetchPayment({ gatewayPaymentId: 'pay_1' }))?.status).toBe('CAPTURED');
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it('fetches a payment by id and maps a documented 404 to null', async () => {
    const fixture = await startFixture({
      'GET /v1/payments/pay_404': (_request, response) => {
        json(response, 404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
      },
      'GET /v1/payments/pay_ok': (_request, response) => {
        json(response, 200, {
          id: 'pay_ok',
          entity: 'payment',
          order_id: 'order_9',
          amount: 150,
          currency: 'INR',
          status: 'authorized',
        });
      },
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    expect(await gateway.fetchPayment({ gatewayPaymentId: 'pay_404' })).toBeNull();
    expect((await gateway.fetchPayment({ gatewayPaymentId: 'pay_ok' }))?.status).toBe('AUTHORIZED');
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it('sends the documented X-Refund-Idempotency header and maps refund statuses', async () => {
    const fixture = await startFixture({
      'POST /v1/payments/pay_1/refund': (_request, response, body) => {
        json(response, 200, {
          id: 'rfnd_FgRAHdNOM4ZVbO',
          entity: 'refund',
          amount: JSON.parse(body).amount,
          currency: 'INR',
          payment_id: 'pay_1',
          status: 'processed',
          receipt: 'refund-abc',
        });
      },
      // Documented refund listing filtered by the durable receipt reference.
      'GET /v1/payments/pay_1/refunds': (_request, response) => {
        json(response, 200, {
          entity: 'collection',
          count: 1,
          items: [
            {
              id: 'rfnd_FgRAHdNOM4ZVbO',
              entity: 'refund',
              amount: 5000,
              currency: 'INR',
              payment_id: 'pay_1',
              status: 'processed',
              receipt: 'refund-abc',
            },
          ],
        });
      },
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    const refund = await gateway.refund({
      refundReference: 'refund-abc',
      gatewayPaymentId: 'pay_1',
      amountPaise: '5000',
    });
    expect(refund).toEqual({ gatewayRefundId: 'rfnd_FgRAHdNOM4ZVbO', status: 'PROCESSED' });
    expect(fixture.requests[0]!.refundIdempotency).toBe('refund-abc');
    expect(JSON.parse(fixture.requests[0]!.body)).toEqual({ amount: 5000, receipt: 'refund-abc' });
    expect(await gateway.findRefundByReceipt('pay_1', 'refund-abc')).toEqual(refund);
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it('maps documented provider failures: 4xx rejection, 409 in-progress retry, 5xx ambiguity', async () => {
    const fixture = await startFixture({
      'POST /v1/payments/pay_reject/refund': (_request, response) =>
        json(response, 400, {
          error: { code: 'BAD_REQUEST_ERROR', description: 'payment not captured' },
        }),
      'POST /v1/payments/pay_conflict/refund': (_request, response) => json(response, 409, {}),
      'POST /v1/payments/pay_boom/refund': (_request, response) => json(response, 500, {}),
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    await expect(
      gateway.refund({
        refundReference: 'refund-reject',
        gatewayPaymentId: 'pay_reject',
        amountPaise: '100',
      }),
    ).rejects.toBeInstanceOf(GatewayRejectedError);
    await expect(
      gateway.refund({
        refundReference: 'refund-conflict',
        gatewayPaymentId: 'pay_conflict',
        amountPaise: '100',
      }),
    ).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(
      gateway.refund({
        refundReference: 'refund-boom',
        gatewayPaymentId: 'pay_boom',
        amountPaise: '100',
      }),
    ).rejects.toBeInstanceOf(GatewayAmbiguousError);
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it('treats an unreachable provider as an ambiguous timeout', async () => {
    const gateway = new RazorpayGateway({
      ...CONFIG,
      baseUrl: 'http://127.0.0.1:9', // closed port: nothing listens
      timeoutMs: 200,
    });
    await expect(
      gateway.createOrder({ operationReference: 'order-x', amountPaise: '100', currency: 'INR' }),
    ).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  it('verifies the documented checkout signature composition with the key secret', () => {
    const gateway = new RazorpayGateway(CONFIG);
    const signature = createHmac('sha256', CONFIG.keySecret)
      .update('order_RB58MiP5SPFYyM|pay_G8PA8ZOhUfRdIV')
      .digest('hex');
    expect(
      gateway.verifyCheckoutSignature({
        gatewayOrderId: 'order_RB58MiP5SPFYyM',
        gatewayPaymentId: 'pay_G8PA8ZOhUfRdIV',
        signature,
      }),
    ).toBe(true);
    expect(
      gateway.verifyCheckoutSignature({
        gatewayOrderId: 'order_RB58MiP5SPFYyM',
        gatewayPaymentId: 'pay_G8PA8ZOhUfRdIV',
        signature: '0'.repeat(64),
      }),
    ).toBe(false);
    expect(
      gateway.verifyCheckoutSignature({
        gatewayOrderId: 'order_RB58MiP5SPFYyM',
        gatewayPaymentId: 'pay_G8PA8ZOhUfRdIV',
        signature: 'short',
      }),
    ).toBe(false);
  });

  it('verifies webhook signatures over the exact raw bytes with the webhook secret', () => {
    const gateway = new RazorpayGateway(CONFIG);
    const raw = new TextEncoder().encode('{"event":"payment.captured"}');
    const signature = createHmac('sha256', CONFIG.webhookSecret).update(raw).digest('hex');
    expect(gateway.verifyWebhook(raw, signature, CONFIG.webhookSecret)).toBe(true);
    // Same content re-serialized is NOT the raw body and must not verify.
    const reserialized = new TextEncoder().encode('{ "event" : "payment.captured" }');
    expect(gateway.verifyWebhook(reserialized, signature, CONFIG.webhookSecret)).toBe(false);
    expect(gateway.verifyWebhook(raw, signature, 'other-secret')).toBe(false);
  });

  it('pages settlements with the documented from/to/count parameters', async () => {
    const fixture = await startFixture({
      'GET /v1/settlements': (request, response, _body) => {
        void _body;
        expect(request.url).toContain('count=2');
        json(response, 200, {
          entity: 'collection',
          count: 2,
          items: [
            {
              id: 'setl_1',
              entity: 'settlement',
              amount: 50000,
              status: 'processed',
              utr: 'UTR1',
              created_at: 1700000000,
            },
            {
              id: 'setl_2',
              entity: 'settlement',
              amount: 25000,
              status: 'created',
              utr: 'UTR2',
              created_at: 1700000100,
            },
          ],
        });
      },
    });
    const gateway = new RazorpayGateway({ ...CONFIG, baseUrl: fixture.url });
    const page = await gateway.fetchSettlements({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.amountPaise).toBe('50000');
    expect(page.items[0]!.gatewaySettlementId).toBe('setl_1');
    expect(page.nextCursor).toBe('2');
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });
});

describe('Razorpay SDK cross-check', () => {
  it('agrees with the constant-time adapter for valid and invalid checkout signatures', async () => {
    const { validatePaymentVerification } = await import('razorpay/dist/utils/razorpay-utils.js');
    const gateway = new RazorpayGateway(CONFIG);
    const orderId = 'order_test_123';
    const paymentId = 'pay_test_123';
    const signature = createHmac('sha256', CONFIG.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    for (const candidate of [signature, '0'.repeat(64)]) {
      expect(
        gateway.verifyCheckoutSignature({
          gatewayOrderId: orderId,
          gatewayPaymentId: paymentId,
          signature: candidate,
        }),
      ).toBe(
        validatePaymentVerification(
          { order_id: orderId, payment_id: paymentId },
          candidate,
          CONFIG.keySecret,
        ),
      );
    }
  });
  it('rejects INR gateway orders below one rupee before contacting Razorpay', async () => {
    const gateway = new RazorpayGateway(CONFIG);
    await expect(
      gateway.createOrder({
        operationReference: 'order-test-123',
        amountPaise: '99',
        currency: 'INR',
      }),
    ).rejects.toThrow('INVALID_MONEY');
  });
});
