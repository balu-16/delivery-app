import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'pino';
import { createProblem, ProblemFilter } from '../../../src/common/http/problem.filter.js';

it('preserves declared domain conflicts and hides unknown vendor details', () => {
  expect(createProblem(409, 'request-1', 'RESOURCE_CONFLICT')).toMatchObject({
    status: 409,
    code: 'RESOURCE_CONFLICT',
    traceId: 'request-1',
  });
  expect(createProblem(409, 'request-2', 'LAST_SUPER_ADMIN').code).toBe('LAST_SUPER_ADMIN');
  expect(JSON.stringify(createProblem(500, 'request-3', 'SQL password=private'))).not.toContain(
    'private',
  );
  expect(createProblem(500, 'request-3').code).toBe('INTERNAL_ERROR');
  expect(createProblem(415, 'request-4').title).toBe('Unsupported Media Type');
});

it('logs unexpected failures with correlation metadata without vendor or request secrets', () => {
  const logged: unknown[] = [];
  let response: unknown;
  const logger = { error: (...args: unknown[]) => logged.push(args) } as Pick<Logger, 'error'>;
  const reply = {
    status() {
      return this;
    },
    type() {
      return this;
    },
    send(body: unknown) {
      response = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'trace-500', method: 'POST', url: '/private?token=request-secret' }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  new ProblemFilter(logger).catch(new Error('SQL password=vendor-secret'), host);
  expect(logged).toEqual([
    [
      { traceId: 'trace-500', method: 'POST', status: 500, code: 'INTERNAL_ERROR' },
      'HTTP request failed',
    ],
  ]);
  expect(response).toMatchObject({ traceId: 'trace-500', status: 500, code: 'INTERNAL_ERROR' });
  expect(JSON.stringify([logged, response])).not.toMatch(/vendor-secret|request-secret/);
});
