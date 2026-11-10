import pino from 'pino';
import { createLogger } from '../../../src/common/logging/logger.js';

it('redacts structured credentials and personal data before writing logs', () => {
  const logger = createLogger('info');
  const stream = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] as {
    write: (message: string) => unknown;
  };
  const originalWrite = stream.write;
  let output = '';
  stream.write = (message) => {
    output += message;
  };
  try {
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer private-token',
            cookie: 'private-cookie',
            'x-api-key': 'private-key',
          },
          body: { name: 'private-body' },
        },
        user: { email: 'private-email', phone: 'private-phone' },
      },
      'request',
    );
    expect(output).toContain('[REDACTED]');
    expect(output).not.toMatch(
      /private-token|private-cookie|private-key|private-body|private-email|private-phone/,
    );
  } finally {
    stream.write = originalWrite;
  }
});
