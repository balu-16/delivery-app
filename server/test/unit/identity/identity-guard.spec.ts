import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { IdentityGuard } from '../../../src/modules/identity/contracts/identity-guard.js';
import type {
  AdminSessionAuthenticator,
  AdminSessions,
} from '../../../src/modules/identity/contracts/admin-auth.js';
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
  const adminSessions = {
    authenticate: async (): Promise<never> => {
      throw new Error('SESSION_EXPIRED');
    },
  } as unknown as AdminSessionAuthenticator;
  const storeSessions = {
    authenticate: async (): Promise<never> => {
      throw new Error('SESSION_EXPIRED');
    },
  } as unknown as AdminSessionAuthenticator;
  const adminRecords = {
    verifyCsrf: async () => true,
  } as unknown as AdminSessions;
  const storeRecords = {
    verifyCsrf: async () => true,
  } as unknown as AdminSessions;
  return {
    guard: new IdentityGuard(
      reflector,
      verifier,
      authorizer,
      limiter,
      adminSessions,
      storeSessions,
      adminRecords,
      storeRecords,
    ),
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
it('rejects a store cookie mutation without a CSRF token', async () => {
  const request = {
    method: 'POST',
    headers: { cookie: 'store_session=abc' },
    url: '/v1/store/status',
  };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: () => ({ audience: 'store', roles: ['STORE_MANAGER'] }),
  } as unknown as Reflector;
  const storePrincipal = { ...principal, roles: ['STORE_MANAGER'] };
  const guard = new IdentityGuard(
    reflector,
    { verify: async () => identity } as TokenVerifier,
    { authorize: async () => storePrincipal } as unknown as IdentityAuthorizer,
    { checkAuthenticated: async () => ({ kind: 'allowed' }) } as RateLimiter,
    {
      authenticate: async () => {
        throw new Error('unused');
      },
    } as unknown as AdminSessionAuthenticator,
    {
      authenticate: async () => ({
        identity,
        principal: storePrincipal,
        sessionId: 'abc',
        csrfToken: 'token',
        rotation: null,
      }),
    } as unknown as AdminSessionAuthenticator,
    { verifyCsrf: async () => true } as unknown as AdminSessions,
    { verifyCsrf: async () => false } as unknown as AdminSessions,
  );
  await expect(guard.canActivate(context)).rejects.toMatchObject({
    response: { code: 'CSRF_TOKEN_INVALID' },
  });
});
function adminCookieContext(opts: {
  method: string;
  csrfPresent?: boolean;
  csrfOk: boolean;
  role: string;
  rotation?: boolean;
  expired?: boolean;
  headers?: Record<string, string>;
}) {
  const headers: Record<string, string> = {};
  const request = {
    method: opts.method,
    headers: {
      cookie: 'admin_session=abc',
      ...(opts.csrfPresent ? { 'x-admin-csrf': 'presented' } : {}),
      ...(opts.headers ?? {}),
    },
    url: '/v1/admin/search',
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
    getAllAndOverride: () => ({ audience: 'admin', roles: ['SUPER_ADMIN'] }),
  } as unknown as Reflector;
  const adminPrincipal = { ...principal, roles: [opts.role] };
  const guard = new IdentityGuard(
    reflector,
    { verify: async () => identity } as TokenVerifier,
    { authorize: async () => adminPrincipal } as unknown as IdentityAuthorizer,
    { checkAuthenticated: async () => ({ kind: 'allowed' }) } as RateLimiter,
    {
      authenticate: async () => {
        if (opts.expired) throw new Error('SESSION_EXPIRED');
        return {
          identity,
          principal: adminPrincipal,
          sessionId: 'abc',
          csrfToken: 'token',
          rotation: opts.rotation
            ? {
                session: {
                  sessionId: 'abc2',
                  csrfToken: 'rotated-token',
                  expiresAt: new Date().toISOString(),
                },
                tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
              }
            : null,
        };
      },
    } as unknown as AdminSessionAuthenticator,
    {
      authenticate: async () => {
        throw new Error('unused');
      },
    } as unknown as AdminSessionAuthenticator,
    {
      verifyCsrf: async (_cookie: string, presented: string) => opts.csrfOk && presented !== '',
    } as unknown as AdminSessions,
    { verifyCsrf: async () => true } as unknown as AdminSessions,
  );
  return { guard, context, headers };
}
it('rejects an admin cookie mutation with a missing CSRF token', async () => {
  const s = adminCookieContext({ method: 'POST', csrfOk: false, role: 'SUPER_ADMIN' });
  await expect(s.guard.canActivate(s.context)).rejects.toMatchObject({
    response: { code: 'CSRF_TOKEN_INVALID' },
  });
});
it('rejects an admin cookie mutation with a stale CSRF token', async () => {
  const s = adminCookieContext({
    method: 'POST',
    csrfPresent: true,
    csrfOk: false,
    role: 'SUPER_ADMIN',
  });
  await expect(s.guard.canActivate(s.context)).rejects.toMatchObject({
    response: { code: 'CSRF_TOKEN_INVALID' },
  });
});
it('allows an admin cookie mutation with a valid CSRF token', async () => {
  const s = adminCookieContext({
    method: 'PATCH',
    csrfPresent: true,
    csrfOk: true,
    role: 'SUPER_ADMIN',
  });
  await expect(s.guard.canActivate(s.context)).resolves.toBe(true);
});
it('does not CSRF-check admin cookie reads', async () => {
  const s = adminCookieContext({ method: 'GET', csrfOk: false, role: 'SUPER_ADMIN' });
  await expect(s.guard.canActivate(s.context)).resolves.toBe(true);
});
it('exposes the rotated CSRF token after admin session rotation', async () => {
  const s = adminCookieContext({
    method: 'GET',
    csrfOk: true,
    role: 'SUPER_ADMIN',
    rotation: true,
  });
  await expect(s.guard.canActivate(s.context)).resolves.toBe(true);
  expect(s.headers['x-admin-csrf']).toBe('rotated-token');
  expect(s.headers['set-cookie']).toContain('admin_session=abc2');
});
it('rejects a cookie session without the portal role even before CSRF', async () => {
  const s = adminCookieContext({
    method: 'POST',
    csrfPresent: true,
    csrfOk: true,
    role: 'SUPPORT_AGENT',
  });
  await expect(s.guard.canActivate(s.context)).rejects.toMatchObject({
    response: { code: 'FORBIDDEN' },
  });
});
it('rejects an expired admin cookie session as SESSION_EXPIRED', async () => {
  const s = adminCookieContext({ method: 'GET', csrfOk: true, role: 'SUPER_ADMIN', expired: true });
  await expect(s.guard.canActivate(s.context)).rejects.toMatchObject({
    response: { code: 'SESSION_EXPIRED' },
  });
});
it('keeps bearer requests on token auth without CSRF', async () => {
  const request = {
    method: 'POST',
    headers: { authorization: 'Bearer [REDACTED]' },
    url: '/v1/admin/search',
  };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: () => ({ audience: 'admin', roles: ['SUPER_ADMIN'] }),
  } as unknown as Reflector;
  const adminPrincipal = { ...principal, roles: ['SUPER_ADMIN'] };
  const guard = new IdentityGuard(
    reflector,
    { verify: async () => identity } as TokenVerifier,
    { authorize: async () => adminPrincipal } as unknown as IdentityAuthorizer,
    { checkAuthenticated: async () => ({ kind: 'allowed' }) } as RateLimiter,
    {
      authenticate: async () => {
        throw new Error('must not be called for bearer');
      },
    } as unknown as AdminSessionAuthenticator,
    {
      authenticate: async () => {
        throw new Error('must not be called for bearer');
      },
    } as unknown as AdminSessionAuthenticator,
    {
      verifyCsrf: async () => {
        throw new Error('must not verify CSRF for bearer');
      },
    } as unknown as AdminSessions,
    {
      verifyCsrf: async () => {
        throw new Error('must not verify CSRF for bearer');
      },
    } as unknown as AdminSessions,
  );
  await expect(guard.canActivate(context)).resolves.toBe(true);
});
it('handles limiter outages according to fail-closed policy', async () => {
  const open = setup(false, { kind: 'unavailable', failClosed: false });
  await expect(open.guard.canActivate(open.context)).resolves.toBe(true);
  const closed = setup(false, { kind: 'unavailable', failClosed: true });
  await expect(closed.guard.canActivate(closed.context)).rejects.toBeInstanceOf(HttpException);
  expect(closed.headers['Retry-After']).toBe('1');
});
