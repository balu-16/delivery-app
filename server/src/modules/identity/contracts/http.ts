import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Audience, Principal, Role, TokenUse, VerifiedIdentity } from './identity.js';
export interface RoutePolicy {
  audience: Audience;
  tokenUse?: TokenUse;
  bootstrap?: boolean;
  allowPendingRider?: boolean;
  roles?: readonly Role[];
}
export const AUTH_POLICY = 'delivery.identity.route-policy';
export const AuthPolicy = (policy: RoutePolicy): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTH_POLICY, policy);
export interface AuthenticatedRequest {
  headers: {
    authorization?: string;
    cookie?: string;
    origin?: string;
    referer?: string;
  };
  url?: string;
  principal?: Principal;
  identity?: VerifiedIdentity;
  ip?: string;
  protocol?: string;
  hostname?: string;
}
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw new Error('PRINCIPAL_MISSING');
    return principal;
  },
);
