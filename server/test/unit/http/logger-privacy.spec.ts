import { createLogger } from '../../../src/common/logging/logger.js';

it('redacts credentials and personal data from structured request logs', () => {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const logger = createLogger('info');
    logger.info(
      {
        req: {
          headers: {
            authorization: 'bearer-canary',
            cookie: 'cookie-canary',
            'x-api-key': 'key-canary',
          },
          body: { phone: 'phone-canary' },
        },
        email: 'email-canary',
        token: 'token-canary',
        address: 'address-canary',
        deliveryCode: 'root-delivery-canary',
        customer: { deliveryCode: 'delivery-canary' },
      },
      'privacy capture',
    );
    const log = chunks.join('');
    expect(log).toContain('[REDACTED]');
    for (const secret of [
      'bearer-canary',
      'cookie-canary',
      'key-canary',
      'phone-canary',
      'email-canary',
      'token-canary',
      'address-canary',
      'delivery-canary',
      'root-delivery-canary',
    ])
      expect(log).not.toContain(secret);
  } finally {
    process.stdout.write = write;
  }
});
