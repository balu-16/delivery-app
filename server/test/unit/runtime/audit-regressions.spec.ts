import { createProblem } from '../../../src/common/http/problem.filter.js';
import { routeLimit } from '../../../src/common/http/rate-limit.js';
import { hashCanonical } from '../../../src/common/idempotency/idempotency.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { CustomerWalletController } from '../../../src/surfaces/customer/wallet/wallet.controller.js';

it('retains a failed wallet top-up replay as an HTTP failure', async () => {
  const store = {
    claim: async () => ({
      kind: 'replay',
      status: 503,
      body: { code: 'ExternalServiceUnavailable' },
    }),
  };
  const controller = new CustomerWalletController({} as never, {} as never, store as never);
  await expect(
    controller.topup({ userId: 'user' } as never, { amountPaise: '100' }, 'same-key'),
  ).rejects.toMatchObject({ status: 503, response: { code: 'ExternalServiceUnavailable' } });
});

it('normalizes object keys without changing array order', () => {
  expect(hashCanonical({ a: 1, nested: { b: 2, a: [1, 2] } })).toBe(
    hashCanonical({ nested: { a: [1, 2], b: 2 }, a: 1 }),
  );
  expect(hashCanonical({ a: [1, 2] })).not.toBe(hashCanonical({ a: [2, 1] }));
});

it('classifies the actual webhook route and accepts only explicit proxy addresses', () => {
  const env = readEnv({ TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::1/128' });
  expect(routeLimit('/v1/customer/webhooks/payments/razorpay', env)).toEqual({
    name: 'webhook',
    limit: 1200,
  });
  expect(routeLimit('/v1/webhooks/payments/razorpay', env)?.name).toBe('default');
  expect(() => readEnv({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })).toThrow('TRUSTED_PROXY_CIDRS');
  expect(createProblem(400, 'trace', 'IDEMPOTENCY_KEY_REQUIRED').code).toBe(
    'IDEMPOTENCY_KEY_REQUIRED',
  );
});
