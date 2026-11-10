import Fastify from 'fastify';
import { ConfigService } from '../../../src/config/config.service.js';
import type { Env } from '../../../src/config/env.schema.js';
import type { PaymentWebhookIngest } from '../../../src/modules/payments/contracts/payments.js';
import { registerWebhookRoute } from '../../../src/surfaces/customer/payments/webhook-route.js';

describe('payment webhook HTTP route', () => {
  it('passes exact request bytes to ingress and rejects a different provider', async () => {
    const app = Fastify();
    const bodies: string[] = [];
    const ingress: PaymentWebhookIngest = {
      ingest: async (input) => {
        bodies.push(Buffer.from(input.rawBody).toString());
        return { inboxId: '1', duplicate: false, accepted: true, state: 'PENDING' };
      },
      processOne: async () => 'SKIPPED',
    };
    const config = new ConfigService({
      HTTP_BODY_LIMIT_BYTES: 1024,
      PAYMENTS_PROVIDER: 'fake',
    } as Env);
    registerWebhookRoute(app, ingress, config);
    const raw = '{ "amount": 1, "nested": [2,3] }';
    const result = await app.inject({
      method: 'POST',
      url: '/v1/customer/webhooks/payments/fake',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(result.statusCode).toBe(200);
    expect(bodies).toEqual([raw]);
    const other = await app.inject({
      method: 'POST',
      url: '/v1/customer/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(other.statusCode).toBe(404);
    await app.close();
  });
});
