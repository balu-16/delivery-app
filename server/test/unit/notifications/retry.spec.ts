import {
  MAX_DELIVERY_ATTEMPTS,
  nextRetryDelaySeconds,
  RETRY_CAP_SECONDS,
} from '../../../src/modules/notifications/domain/retry.js';

describe('delivery retry backoff', () => {
  it('grows exponentially and never exceeds the cap', () => {
    const noJitter = (attempt: number) => nextRetryDelaySeconds(attempt, () => 0);
    expect(noJitter(1)).toBe(2);
    expect(noJitter(4)).toBe(16);
    expect(noJitter(8)).toBe(256);
    expect(noJitter(9)).toBe(RETRY_CAP_SECONDS);
    expect(noJitter(10)).toBe(RETRY_CAP_SECONDS);
  });
  it('adds non-negative jitter within the bounded band', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const delay = nextRetryDelaySeconds(attempt, Math.random);
      const base = Math.min(RETRY_CAP_SECONDS, 2 ** Math.min(attempt, 9));
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base + Math.max(1, Math.floor(base * 0.25)));
    }
  });
  it('rejects invalid attempt numbers', () => {
    expect(() => nextRetryDelaySeconds(0)).toThrow('INVALID_ATTEMPT');
    expect(() => nextRetryDelaySeconds(-1)).toThrow('INVALID_ATTEMPT');
  });
  it('keeps the documented attempt bound', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(MAX_DELIVERY_ATTEMPTS).toBeLessThanOrEqual(20);
  });
});
