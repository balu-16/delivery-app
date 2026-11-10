import {
  screenBatch,
  shouldPersist,
  INTEGRITY_DEFAULTS,
} from '../../../src/modules/tracking/domain/integrity.js';
import { computeEta, etaChanged } from '../../../src/modules/tracking/domain/eta.js';
import { haversineMetres } from '../../../src/modules/tracking/domain/geo.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const point = (offsetMs: number, overrides: Record<string, unknown> = {}) => ({
  ts: at(offsetMs),
  lat: 12.9,
  lng: 77.6,
  ...overrides,
});

describe('GPS integrity gate (DSP-03)', () => {
  test('clean ascending batches are fully accepted', () => {
    const result = screenBatch([point(0), point(5000), point(10_000)], NOW, null);
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  test('mock GPS points are dropped, never stored or published', () => {
    const result = screenBatch([point(0, { isMock: true }), point(5000)], NOW, null);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ reason: 'MOCK_GPS', count: 1 }]);
  });

  test('poor accuracy and future skew are rejected', () => {
    const result = screenBatch(
      [point(0, { accuracyM: 500 }), point(5000), point(10 * 60_000, { accuracyM: 10 })],
      NOW,
      null,
      { ...INTEGRITY_DEFAULTS, maxFutureSkewSeconds: 60 },
    );
    expect(result.accepted.map((entry) => entry.ts.getTime())).toEqual([NOW.getTime() + 5000]);
    expect(result.rejected).toEqual([
      { reason: 'POOR_ACCURACY', count: 1 },
      { reason: 'FUTURE_SKEW', count: 1 },
    ]);
  });

  test('teleports between consecutive points are rejected (impossible speed)', () => {
    // ~15 km in 1 second is far beyond the 250 km/h cap.
    const teleport = { ts: at(1000), lat: 13.0, lng: 77.6 };
    const result = screenBatch(
      [point(0), teleport, point(2000, { lat: 12.9001, lng: 77.6 })],
      NOW,
      null,
    );
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([{ reason: 'IMPOSSIBLE_SPEED', count: 1 }]);
  });

  test('duplicate timestamps and out-of-order points never replace newer state', () => {
    const result = screenBatch([point(5000), point(5000), point(1000), point(6000)], NOW, null);
    expect(result.accepted.map((entry) => entry.ts.getTime())).toEqual([
      NOW.getTime() + 5000,
      NOW.getTime() + 6000,
    ]);
    expect(result.rejected).toEqual([
      { reason: 'DUPLICATE_TS', count: 1 },
      { reason: 'OUT_OF_ORDER', count: 1 },
    ]);
  });

  test('points older than the last stored point are pruned (ADD-19 ordering)', () => {
    const lastStored = { ts: new Date(NOW.getTime() - 5000), lat: 12.9, lng: 77.6 };
    const result = screenBatch([point(-10_000), point(0)], NOW, lastStored);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ reason: 'OUT_OF_ORDER', count: 1 }]);
  });

  test('oversized batches fail the whole request', () => {
    const flood = Array.from({ length: 51 }, (_, i) => point(i * 1000));
    expect(() => screenBatch(flood, NOW, null)).toThrow('BATCH_TOO_LARGE');
    expect(() => screenBatch(flood.slice(0, 50), NOW, null)).not.toThrow();
  });

  test('sampling persists on the interval OR the distance condition (ADD-19)', () => {
    const last = { ts: new Date(NOW.getTime() - 5000), lat: 12.9, lng: 77.6 };
    // 5 s later, same place: interval not reached, distance not reached.
    expect(shouldPersist(last, { ts: NOW, lat: 12.9, lng: 77.6 })).toBe(false);
    // 10 s later at the same place: still below the 15 s interval.
    expect(shouldPersist(last, { ts: new Date(NOW.getTime() + 5000), lat: 12.9, lng: 77.6 })).toBe(
      false,
    );
    // 16 s later at the same place: interval condition met.
    expect(
      shouldPersist(last, { ts: new Date(NOW.getTime() + 11_000), lat: 12.9, lng: 77.6 }),
    ).toBe(true);
    // 5 s later but 60 m away: distance condition met.
    const far = { ts: NOW, lat: 12.90054, lng: 77.6 };
    expect(shouldPersist(last, far)).toBe(true);
    expect(shouldPersist(null, far)).toBe(true);
  });

  test('haversine is stable for local distances', () => {
    const metres = haversineMetres({ lat: 12.9, lng: 77.6 }, { lat: 12.9001, lng: 77.6 });
    expect(metres).toBeGreaterThan(9);
    expect(metres).toBeLessThan(13);
    expect(haversineMetres({ lat: 12.9, lng: 77.6 }, { lat: 12.9, lng: 77.6 })).toBe(0);
  });
});

describe('v1 ETA (23.5)', () => {
  const config = { roadFactor: 1.4, avgSpeedKph: 20, maxMinutes: 60 };

  test('publishes a range around the haversine estimate', () => {
    // 1 km at 20 kph with 1.4 road factor ≈ 4.2 min.
    const range = computeEta({ storeToCustomerMetres: 1000, pickedUp: true }, config);
    expect(range.minMinutes).toBeGreaterThanOrEqual(1);
    expect(range.maxMinutes).toBeGreaterThan(range.minMinutes);
    expect(range.maxMinutes).toBeLessThanOrEqual(60);
  });

  test('pre-pickup includes the rider-to-store leg', () => {
    const picked = computeEta({ storeToCustomerMetres: 1000, pickedUp: true }, config);
    const both = computeEta(
      { storeToCustomerMetres: 1000, riderToStoreMetres: 2000, pickedUp: false },
      config,
    );
    expect(both.minMinutes).toBeGreaterThan(picked.minMinutes);
  });

  test('ETA never counts below one minute and clamps to the maximum', () => {
    expect(computeEta({ storeToCustomerMetres: 1, pickedUp: true }, config).minMinutes).toBe(1);
    const huge = computeEta({ storeToCustomerMetres: 100_000_000, pickedUp: true }, config);
    expect(huge.maxMinutes).toBe(60);
  });

  test('anti-jitter publishes only when the range moves by the delta', () => {
    const range = { minMinutes: 10, maxMinutes: 15 };
    expect(etaChanged(null, range)).toBe(true);
    expect(etaChanged(range, { minMinutes: 10, maxMinutes: 15 })).toBe(false);
    expect(etaChanged(range, { minMinutes: 11, maxMinutes: 15 })).toBe(true);
    expect(etaChanged(range, { minMinutes: 10, maxMinutes: 16 })).toBe(true);
  });
});
