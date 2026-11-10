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

@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(IDENTITY_AUTHORIZER) private readonly identities: IdentityAuthorizer,
    @Inject(PLATFORM_RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RoutePolicy>(AUTH_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) throw new ForbiddenException({ code: 'ROUTE_POLICY_MISSING' });
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
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
