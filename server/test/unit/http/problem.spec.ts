import { HttpException } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { DOMAIN_ERROR_STATUS } from '../../../src/common/http/problem-codes.js';
import { createProblem } from '../../../src/common/http/problem.filter.js';
import { DomainErrorInterceptor } from '../../../src/surfaces/domain-errors.js';

const interceptor = new DomainErrorInterceptor();
async function translate(error: unknown): Promise<unknown> {
  try {
    await firstValueFrom(
      interceptor.intercept({} as never, { handle: () => throwError(() => error) }),
    );
  } catch (caught) {
    return caught;
  }
  throw new Error('expected an error');
}

test('every translated domain error retains its safe code in the HTTP problem', async () => {
  for (const [code, status] of Object.entries(DOMAIN_ERROR_STATUS)) {
    const error = await translate(new Error(code));
    expect(error).toBeInstanceOf(HttpException);
    const response = error as HttpException;
    expect(response.getStatus()).toBe(status);
    expect(
      createProblem(status, 'trace', (response.getResponse() as { code: string }).code).code,
    ).toBe(code);
  }
});

test('unknown messages, prototype keys and wrong status cannot be reflected', async () => {
  const secret = 'database password: canary';
  const error = new Error(secret);
  expect(await translate(error)).toBe(error);
  expect(createProblem(500, 'trace', secret)).toEqual({
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    code: 'INTERNAL_ERROR',
    detail: 'Internal Server Error',
    traceId: 'trace',
  });
  expect(createProblem(400, 'trace', 'constructor').code).toBe('BAD_REQUEST');
  expect(createProblem(400, 'trace', 'QUOTE_EXPIRED').code).toBe('BAD_REQUEST');
});

test.each([
  ['23505', 409, 'RESOURCE_CONFLICT'],
  ['22P02', 400, 'INVALID_INPUT'],
] as const)('sanitizes database error %s', async (pg, status, code) => {
  const response = (await translate(
    Object.assign(new Error('sensitive SQL'), { code: pg }),
  )) as HttpException;
  expect(response.getStatus()).toBe(status);
  expect(
    createProblem(status, 'trace', (response.getResponse() as { code: string }).code).code,
  ).toBe(code);
});
