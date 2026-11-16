import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_RATE_LIMITER, type RateLimiter } from '../../../platform/contracts/rate-limit.js';
import { AUTH_POLICY, type AuthenticatedRequest, type RoutePolicy } from './http.js';
import { TOKEN_VERIFIER, type TokenVerifier } from './identity.js';
import { IDENTITY_AUTHORIZER, type IdentityAuthorizer } from './identity.js';
import {
  ADMIN_SESSION_AUTHENTICATOR,
  STORE_SESSION_AUTHENTICATOR,
  STORE_SESSIONS,
} from './admin-auth.js';
import type { AdminSessionAuthenticator, AdminSessions } from './admin-auth.js';
import { AdminSessionForbidden, AdminSessionUnavailable } from './admin-auth.js';

/** Read the admin portal session cookie without pulling in a cookie parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value ? value : null;
  }
  return null;
}

/** Translate cookie-session domain errors into HTTP semantics; outages stay retryable (503). */
export function translateAdminSessionError(error: unknown): unknown {
  if (error instanceof AdminSessionUnavailable)
    return new ServiceUnavailableException({ code: 'ExternalServiceUnavailable' });
  if (error instanceof AdminSessionForbidden) return new ForbiddenException({ code: error.code });
  if (error instanceof HttpException || error instanceof ForbiddenException) return error;
  if (error instanceof Error && error.message === 'SESSION_REPLACED')
    return new HttpException({ code: 'SESSION_REPLACED' }, 401);
  return new UnauthorizedException({ code: 'SESSION_EXPIRED' });
}

@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(IDENTITY_AUTHORIZER) private readonly identities: IdentityAuthorizer,
    @Inject(PLATFORM_RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(ADMIN_SESSION_AUTHENTICATOR)
    private readonly adminSessions: AdminSessionAuthenticator,
    @Inject(STORE_SESSION_AUTHENTICATOR)
    private readonly storeSessions: AdminSessionAuthenticator,
    @Inject(STORE_SESSIONS) private readonly storeSessionRecords: AdminSessions,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RoutePolicy>(AUTH_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) throw new ForbiddenException({ code: 'ROUTE_POLICY_MISSING' });
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
    // Each portal audience carries its own session cookie name, keeping the
    // credentials (and their logout) independent; other audiences stay bearer-only.
    const sessionCookie =
      policy.audience === 'admin'
        ? readCookie(request.headers.cookie, 'admin_session')
        : policy.audience === 'store'
          ? readCookie(request.headers.cookie, 'store_session')
          : null;
    // Presenting both credential kinds on a portal route is always a client defect.
    if (match?.[1] && sessionCookie)
      throw new HttpException({ code: 'CONFLICTING_CREDENTIALS' }, 409);
    if (!match?.[1] && sessionCookie) {
      const authenticator = policy.audience === 'store' ? this.storeSessions : this.adminSessions;
      let authenticated;
      try {
        authenticated = await authenticator.authenticate(sessionCookie);
      } catch (error: unknown) {
        throw translateAdminSessionError(error);
      }
      request.identity = authenticated.identity;
      request.principal = authenticated.principal;
      // Cookie sessions are portal sessions: the portal's single role on every
      // request, even where the route policy also admits other audience roles.
      const requiredRole = policy.audience === 'store' ? 'STORE_MANAGER' : 'SUPER_ADMIN';
      if (!authenticated.principal.roles.includes(requiredRole))
        throw new ForbiddenException({ code: 'FORBIDDEN' });
      if (
        policy.audience === 'store' &&
        !['GET', 'HEAD', 'OPTIONS'].includes((request.method ?? 'GET').toUpperCase())
      ) {
        const presented = request.headers['x-store-csrf'];
        const token = Array.isArray(presented) ? presented[0] : presented;
        if (!(await this.storeSessionRecords.verifyCsrf(sessionCookie, token ?? '')))
          throw new ForbiddenException({ code: 'CSRF_TOKEN_INVALID' });
      }
      if (authenticated.rotation)
        context
          .switchToHttp()
          .getResponse<{ header(name: string, value: string): void }>()
          .header(
            'set-cookie',
            portalSessionCookie(
              policy.audience === 'store' ? 'store_session' : 'admin_session',
              authenticated.rotation.session.sessionId,
              new Date(authenticated.rotation.session.expiresAt),
              { secure: cookieSecure(request) },
            ),
          );
      await this.limit(context, request, policy.audience);
      return true;
    }
    if (!match?.[1]) throw new UnauthorizedException({ code: 'INVALID_TOKEN' });
    try {
      request.identity = await this.verifier.verify(
        match[1],
        policy.audience,
        policy.tokenUse ?? 'access',
      );
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN' });
    }
    if (policy.bootstrap) {
      await this.limit(context, request, policy.audience);
      return true;
    }
    try {
      request.principal = await this.identities.authorize(
        request.identity,
        policy.audience,
        policy.allowPendingRider,
      );
    } catch (error: unknown) {
      const code =
        error instanceof Error &&
        ['PROFILE_NOT_INITIALIZED', 'ACCOUNT_DISABLED', 'RIDER_NOT_APPROVED', 'FORBIDDEN'].includes(
          error.message,
        )
          ? error.message
          : 'FORBIDDEN';
      throw new ForbiddenException({ code });
    }
    if (policy.roles && !request.principal.roles.some((role) => policy.roles!.includes(role)))
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    await this.limit(context, request, policy.audience);
    return true;
  }
  private async limit(
    context: ExecutionContext,
    request: AuthenticatedRequest,
    audience: string,
  ): Promise<void> {
    const identity = request.identity!;
    const decision = await this.rateLimiter.checkAuthenticated(
      `${identity.pool}:${identity.sub}`,
      audience,
      request.url ?? '',
    );
    if (decision.kind === 'limited') {
      context
        .switchToHttp()
        .getResponse<{ header(name: string, value: string): void }>()
        .header('Retry-After', String(decision.retryAfter));
      throw new HttpException('Too Many Requests', 429);
    }
    if (decision.kind === 'unavailable' && decision.failClosed) {
      context
        .switchToHttp()
        .getResponse<{ header(name: string, value: string): void }>()
        .header('Retry-After', '1');
      throw new ServiceUnavailableException();
    }
  }
}

/**
 * Secure cookie everywhere except loopback plain HTTP development: HTTPS and
 * production always get the Secure attribute; a non-loopback plain-HTTP
 * request also gets it (the browser then refuses the cookie, failing safe).
 */
export function cookieSecure(request: {
  protocol?: string;
  hostname?: string;
  ip?: string;
}): boolean {
  if ((request.protocol ?? 'http') === 'https') return true;
  const host = (request.hostname ?? '').toLowerCase();
  const ip = request.ip ?? '';
  const loopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('127.');
  return !loopback;
}

/** Host-only portal session cookie; Secure everywhere except loopback HTTP development. */
export function portalSessionCookie(
  name: 'admin_session' | 'store_session',
  sessionId: string,
  absoluteExpiresAt: Date,
  options?: { secure?: boolean; clear?: boolean; browserSession?: boolean },
): string {
  const attributes = [`${name}=${sessionId}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options?.clear) attributes.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  else if (!options?.browserSession) {
    // "Remember me" opt-out: a browser-session cookie dies with the browser;
    // a page refresh always survives either way.
    const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1000));
    attributes.push(`Max-Age=${maxAge}`);
  }
  if (options?.secure ?? true) attributes.push('Secure');
  return attributes.join('; ');
}

export function adminSessionCookie(
  sessionId: string,
  absoluteExpiresAt: Date,
  options?: { secure?: boolean; clear?: boolean },
): string {
  return portalSessionCookie('admin_session', sessionId, absoluteExpiresAt, options);
}

export function storeSessionCookie(
  sessionId: string,
  absoluteExpiresAt: Date,
  options?: { secure?: boolean; clear?: boolean; browserSession?: boolean },
): string {
  return portalSessionCookie('store_session', sessionId, absoluteExpiresAt, options);
}
