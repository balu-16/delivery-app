import type { LocationPointInput } from '../contracts/tracking.js';
import { haversineMetres, isValidCoordinate } from './geo.js';

export type RejectionReason =
  | 'MOCK_GPS'
  | 'POOR_ACCURACY'
  | 'IMPOSSIBLE_SPEED'
  | 'FUTURE_SKEW'
  | 'OUT_OF_ORDER'
  | 'DUPLICATE_TS'
  | 'INVALID_COORDS'
  | 'BATCH_TOO_LARGE'
  | 'INVALID_TIMESTAMP';

export interface IntegrityConfig {
  /** Batch hard cap; the whole request is rejected when exceeded. */
  maxBatchPoints: number;
  maxFutureSkewSeconds: number;
  maxAccuracyMetres: number;
  /** 250 km/h default: anything faster is a teleport, not a ride. */
  maxSpeedMps: number;
  /** Sample history to Postgres at (>= interval) OR (>= distance). */
  minPersistIntervalSeconds: number;
  minPersistDistanceMetres: number;
}

export const INTEGRITY_DEFAULTS: IntegrityConfig = {
  maxBatchPoints: 50,
  maxFutureSkewSeconds: 60,
  maxAccuracyMetres: 100,
  maxSpeedMps: 250 / 3.6,
  minPersistIntervalSeconds: 15,
  minPersistDistanceMetres: 50,
};

export interface ScreenedPoint {
  input: LocationPointInput;
  ts: Date;
}

export interface ScreenResult {
  accepted: ScreenedPoint[];
  rejected: { reason: RejectionReason; count: number }[];
}

/**
 * Pure GPS integrity gate (23.3/DSP-03): mock, poor accuracy, teleports,
 * future skew, duplicates and out-of-order points never reach storage.
 * Points are processed in ascending ts; the last stored point prunes older ones.
 */
export function screenBatch(
  points: readonly LocationPointInput[],
  now: Date,
  lastStored: { ts: Date; lat: number; lng: number } | null,
  config: IntegrityConfig = INTEGRITY_DEFAULTS,
): ScreenResult {
  if (points.length > config.maxBatchPoints) throw new Error('BATCH_TOO_LARGE');
  const counters = new Map<RejectionReason, number>();
  const reject = (reason: RejectionReason) => {
    counters.set(reason, (counters.get(reason) ?? 0) + 1);
  };
  const seenTs = new Set<string>();
  const accepted: ScreenedPoint[] = [];
  let previous: { ts: Date; lat: number; lng: number } | null = lastStored;
  for (const point of points) {
    const tsMs = Date.parse(point.ts);
    if (!Number.isFinite(tsMs)) {
      reject('INVALID_TIMESTAMP');
      continue;
    }
    const ts = new Date(tsMs);
    if (!isValidCoordinate(point.lat, point.lng)) {
      reject('INVALID_COORDS');
      continue;
    }
    if (ts.getTime() > now.getTime() + config.maxFutureSkewSeconds * 1000) {
      reject('FUTURE_SKEW');
      continue;
    }
    if (point.isMock) {
      reject('MOCK_GPS');
      continue;
    }
    if (point.accuracyM !== undefined && point.accuracyM > config.maxAccuracyMetres) {
      reject('POOR_ACCURACY');
      continue;
    }
    if (seenTs.has(point.ts)) {
      reject('DUPLICATE_TS');
      continue;
    }
    if (previous && ts.getTime() <= previous.ts.getTime()) {
      reject('OUT_OF_ORDER');
      continue;
    }
    if (previous) {
      const metres = haversineMetres(previous, point);
      const seconds = Math.max(1, (ts.getTime() - previous.ts.getTime()) / 1000);
      if (metres / seconds > config.maxSpeedMps) {
        reject('IMPOSSIBLE_SPEED');
        continue;
      }
    }
    seenTs.add(point.ts);
    accepted.push({ input: point, ts });
    previous = { ts, lat: point.lat, lng: point.lng };
  }
  return {
    accepted,
    rejected: [...counters.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Sampling to the daily-partitioned history (ADD-19): a point is persisted
 * when it moved at least the configured distance OR at least the configured
 * interval since the last persisted point; the first point always persists.
 */
export function shouldPersist(
  lastPersisted: { ts: Date; lat: number; lng: number } | null,
  point: { ts: Date; lat: number; lng: number },
  config: IntegrityConfig = INTEGRITY_DEFAULTS,
): boolean {
  if (!lastPersisted) return true;
  if (point.ts.getTime() <= lastPersisted.ts.getTime()) return false;
  const metres = haversineMetres(lastPersisted, point);
  if (metres >= config.minPersistDistanceMetres) return true;
  return (
    (point.ts.getTime() - lastPersisted.ts.getTime()) / 1000 >= config.minPersistIntervalSeconds
  );
}
