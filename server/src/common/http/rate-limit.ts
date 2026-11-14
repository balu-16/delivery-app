import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.schema.js';

const WINDOW_SECONDS = 60;
// Set expiry only on first increment in the same atomic server-side operation.
const SCRIPT = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n, redis.call('TTL',KEYS[1])}`;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number;
}
export function routeLimit(path: string, env: Env): { name: string; limit: number } | undefined {
  if (['/healthz', '/readyz', '/metrics'].includes(path)) return undefined;
  // A separate generous limit protects ingress while provider deliveries remain
  // reachable during Redis outages under the normal fail-open policy.
  if (/^\/v1\/customer\/webhooks\/payments\/(?:fake|razorpay)$/.test(path))
    return { name: 'webhook', limit: env.RATE_LIMIT_WEBHOOK_PER_MIN };
  // Admin portal authentication is anonymous until a session exists; keep its
  // counters separate from the staff bearer routes under the same per-IP cap.
  if (/^\/v1\/admin\/auth(?:\/|$)/.test(path))
    return { name: 'admin-auth', limit: env.RATE_LIMIT_AUTH_PER_MIN };
  if (/\/(?:auth|places)(?:\/|$)/.test(path))
    return { name: 'auth', limit: env.RATE_LIMIT_AUTH_PER_MIN };
  if (/\/search(?:\/|$)/.test(path))
    return { name: 'search', limit: env.RATE_LIMIT_SEARCH_PER_MIN };
  if (/\/location(?:\/|$)/.test(path))
    return { name: 'location', limit: env.RATE_LIMIT_LOCATION_PER_MIN };
  return { name: 'default', limit: env.RATE_LIMIT_DEFAULT_PER_MIN };
}

/** Shared fixed-window limit. The key contains a hash, never the caller's IP. */
export async function checkRateLimit(
  redis: Pick<Redis, 'eval'>,
  actor: string,
  routeClass: string,
  limit: number,
): Promise<RateLimitDecision> {
  const digest = createHash('sha256').update(actor).digest('hex');
  const result = await redis.eval(
    SCRIPT,
    1,
    `delivery:rate:${routeClass}:${digest}`,
    WINDOW_SECONDS,
  );
  if (!Array.isArray(result) || result.length !== 2) throw new Error('RATE_LIMIT_UNAVAILABLE');
  const count = Number(result[0]);
  const ttl = Number(result[1]);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl))
    throw new Error('RATE_LIMIT_UNAVAILABLE');
  return { allowed: count <= limit, retryAfter: Math.max(1, ttl) };
}
