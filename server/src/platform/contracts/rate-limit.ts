export const PLATFORM_RATE_LIMITER = Symbol('PLATFORM_RATE_LIMITER');
export type AuthenticatedLimitDecision =
  | { kind: 'allowed' }
  | { kind: 'limited'; retryAfter: number }
  | { kind: 'unavailable'; failClosed: boolean };

/** actor must be derived from an already verified identity, never unverified JWT claims. */
export interface RateLimiter {
  checkAuthenticated(
    actor: string,
    audience: string,
    path: string,
  ): Promise<AuthenticatedLimitDecision>;
}
