import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { IdentityGuard } from '../../../src/modules/identity/contracts/identity-guard.js';
import type {
  IdentityAuthorizer,
  Principal,
  TokenVerifier,
  VerifiedIdentity,
} from '../../../src/modules/identity/contracts/identity.js';
import type {
  AuthenticatedLimitDecision,
  RateLimiter,
} from '../../../src/platform/contracts/rate-limit.js';

const identity: VerifiedIdentity = {
  pool: 'CUSTOMER',
  sub: 'verified-sub',
  tokenUse: 'access',
  groups: [],
  expiresAt: 9999999999,
};
const principal: Principal = {
  userId: 'local-user',
  pool: 'CUSTOMER',
  sub: 'verified-sub',
  roles: ['CUSTOMER'],
  status: 'ACTIVE',
  emailVerified: true,
  authVersion: '1',
  riderStatus: null,
};
function setup(bootstrap: boolean, decision: AuthenticatedLimitDecision) {
  const calls: unknown[][] = [],
    headers: Record<string, string> = {};
  const request = {
    headers: { authorization: 'Bearer cryptographically-verified' },
    url: '/v1/customer/auth/bootstrap',
  };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({
        header: (key: string, value: string) => {
          headers[key] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: () => ({ audience: 'customer', bootstrap }),
  } as unknown as Reflector;
  const verifier = { verify: async () => identity } as TokenVerifier;
  const authorizer = { authorize: async () => principal } as unknown as IdentityAuthorizer;
  const limiter: RateLimiter = {
    checkAuthenticated: async (...args) => {
      calls.push(args);
      return decision;
    },
  };
  return {
    guard: new IdentityGuard(reflector, verifier, authorizer, limiter),
    context,
    calls,
    headers,
  };
}
it.each([true, false])(
  'limits only the verified pool and subject for bootstrap=%s',
  async (bootstrap) => {
    const s = setup(bootstrap, { kind: 'allowed' });
    expect(await s.guard.canActivate(s.context)).toBe(true);
    expect(s.calls).toEqual([['CUSTOMER:verified-sub', 'customer', '/v1/customer/auth/bootstrap']]);
  },
);
it('returns 429 with Retry-After for a limited actor', async () => {
  const s = setup(false, { kind: 'limited', retryAfter: 12 });
  await expect(s.guard.canActivate(s.context)).rejects.toMatchObject({ status: 429 });
  expect(s.headers['Retry-After']).toBe('12');
});
it('handles limiter outages according to fail-closed policy', async () => {
  const open = setup(false, { kind: 'unavailable', failClosed: false });
  await expect(open.guard.canActivate(open.context)).resolves.toBe(true);
  const closed = setup(false, { kind: 'unavailable', failClosed: true });
  await expect(closed.guard.canActivate(closed.context)).rejects.toBeInstanceOf(HttpException);
  expect(closed.headers['Retry-After']).toBe('1');
});
