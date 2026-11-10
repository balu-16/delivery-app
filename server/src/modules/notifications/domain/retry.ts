/**
 * Send-retry policy for channel deliveries: exponential backoff with jitter,
 * bounded. Attempt 1 is the first failure; the delay applies before retry N.
 */
export const MAX_DELIVERY_ATTEMPTS = 8;
export const RETRY_CAP_SECONDS = 300;

export function nextRetryDelaySeconds(
  failedAttempt: number,
  rand: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) throw new Error('INVALID_ATTEMPT');
  const exponential = Math.min(RETRY_CAP_SECONDS, 2 ** Math.min(failedAttempt, 9));
  // Jitter inside ±25% keeps thundering-herd retries apart.
  const jitter = Math.floor(rand() * Math.max(1, Math.floor(exponential * 0.25)));
  return exponential + jitter;
}
