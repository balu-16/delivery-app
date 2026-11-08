import {
  assertCanGoOnline,
  hasTaskCapacity,
  isHeartbeatStale,
  isLocationFresh,
  passesCashLimit,
  rejectionFor,
} from '../../../src/modules/riders/domain/policy.js';

const NOW = new Date('2026-11-07T10:00:00Z');

describe('rider operational policy', () => {
  test('only APPROVED riders go online; suspension rejects explicitly (D08)', () => {
    expect(() => assertCanGoOnline('APPROVED')).not.toThrow();
    expect(() => assertCanGoOnline('PENDING')).toThrow('RIDER_NOT_APPROVED');
    expect(() => assertCanGoOnline('UNDER_REVIEW')).toThrow('RIDER_NOT_APPROVED');
    expect(() => assertCanGoOnline('REJECTED')).toThrow('RIDER_NOT_APPROVED');
    expect(() => assertCanGoOnline('SUSPENDED')).toThrow('RIDER_SUSPENDED');
  });

  test('location freshness gates dispatch candidates (D22/ADD-17)', () => {
    expect(isLocationFresh(new Date(NOW.getTime() - 30_000), NOW, 120)).toBe(true);
    expect(isLocationFresh(new Date(NOW.getTime() - 121_000), NOW, 120)).toBe(false);
    expect(isLocationFresh(null, NOW, 120)).toBe(false);
  });

  test('heartbeat staleness marks silent riders unreachable', () => {
    expect(isHeartbeatStale(new Date(NOW.getTime() - 10_000), NOW, 60)).toBe(false);
    expect(isHeartbeatStale(new Date(NOW.getTime() - 61_000), NOW, 60)).toBe(true);
    expect(isHeartbeatStale(null, NOW, 60)).toBe(true);
  });

  test('task capacity is a strict upper bound (ADD-18)', () => {
    expect(hasTaskCapacity(0, 3)).toBe(true);
    expect(hasTaskCapacity(2, 3)).toBe(true);
    expect(hasTaskCapacity(3, 3)).toBe(false);
    expect(hasTaskCapacity(4, 3)).toBe(false);
  });

  test('COD cash limit blocks assignment above the configured ceiling (DSP-06)', () => {
    expect(passesCashLimit(1000n, '500', '2000')).toBe(true);
    expect(passesCashLimit(1500n, '500', '2000')).toBe(true);
    expect(passesCashLimit(1501n, '500', '2000')).toBe(false);
    expect(passesCashLimit(0n, '2000000', '2000000')).toBe(true);
    expect(passesCashLimit(1n, '2000000', '2000000')).toBe(false);
    // Without a published limit the check fails open (config not yet in DB).
    expect(passesCashLimit(999999n, '500', null)).toBe(true);
  });

  test('rejections report the first failing check in evaluation order', () => {
    expect(rejectionFor([])).toEqual({ eligible: true });
    expect(rejectionFor([null, 'OFFLINE'])).toEqual({ eligible: false, reason: 'OFFLINE' });
    expect(rejectionFor(['STALE_LOCATION', 'OFFLINE'])).toEqual({
      eligible: false,
      reason: 'STALE_LOCATION',
    });
  });
});
