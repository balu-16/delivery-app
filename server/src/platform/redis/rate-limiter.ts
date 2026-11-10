import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.schema.js';
import { checkRateLimit, routeLimit } from '../../common/http/rate-limit.js';
import type { RateLimiter, AuthenticatedLimitDecision } from '../contracts/rate-limit.js';

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly env: Env,
    private readonly onError: () => void,
  ) {}
  async checkAuthenticated(
    actor: string,
    audience: string,
    path: string,
  ): Promise<AuthenticatedLimitDecision> {
    const route = routeLimit(path.split('?')[0] ?? '', this.env);
    if (!route) return { kind: 'allowed' };
    try {
      const result = await checkRateLimit(
        this.redis,
        actor,
        `actor:${audience}:${route.name}`,
        route.limit,
      );
      return result.allowed
        ? { kind: 'allowed' }
        : { kind: 'limited', retryAfter: result.retryAfter };
    } catch {
      this.onError();
      return { kind: 'unavailable', failClosed: route.name === 'location' };
    }
  }
}
