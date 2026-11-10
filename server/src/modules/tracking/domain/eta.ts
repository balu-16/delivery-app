import type { EtaInput, EtaRange } from '../contracts/tracking.js';
import { INTEGRITY_DEFAULTS, type IntegrityConfig } from './integrity.js';

/** Default ETA and ingestion tuning values, also used by local fixtures. */
export const TRACKING_CONFIG_DEFAULTS = {
  locationMinIntervalSeconds: INTEGRITY_DEFAULTS.minPersistIntervalSeconds,
  locationMinDistanceMetres: INTEGRITY_DEFAULTS.minPersistDistanceMetres,
  locationMaxBatchPoints: INTEGRITY_DEFAULTS.maxBatchPoints,
  locationMaxAccuracyMetres: INTEGRITY_DEFAULTS.maxAccuracyMetres,
  locationMaxSpeedMps: INTEGRITY_DEFAULTS.maxSpeedMps,
  etaRoadFactor: 1.4,
  etaAvgSpeedKph: 20,
  etaPublishDeltaMinutes: 1,
  etaMaxMinutes: 60,
  locationRetentionDays: 30,
} as const;

export type TrackingDefaultKey =
  keyof typeof TRACKING_CONFIG_DEFAULTS | 'riderStaleLocationSeconds';

export interface EtaConfig {
  roadFactor: number;
  avgSpeedKph: number;
  maxMinutes: number;
}

/**
 * Pure v1 ETA (23.5): haversine metres × road factor ÷ average speed,
 * published as a range and never counting below one minute until arrival.
 */
export function computeEta(input: EtaInput, config: EtaConfig): EtaRange {
  const speedMps = Math.max(config.avgSpeedKph, 1) / 3.6;
  const travelMetres = input.pickedUp
    ? input.storeToCustomerMetres
    : (input.riderToStoreMetres ?? 0) + input.storeToCustomerMetres;
  const prepSeconds = Math.max(0, input.remainingPrepSeconds ?? 0);
  const etaSeconds = prepSeconds + (travelMetres * config.roadFactor) / speedMps;
  const centre = Math.max(1, etaSeconds / 60);
  const min = Math.min(config.maxMinutes, Math.max(1, Math.floor(centre * 0.85)));
  const max = Math.min(config.maxMinutes, Math.max(min + 1, Math.ceil(centre * 1.3)));
  return { minMinutes: min, maxMinutes: max };
}

/** Anti-jitter: publish only when the range moved by at least the delta. */
export function etaChanged(
  previous: EtaRange | null,
  next: EtaRange,
  deltaMinutes = TRACKING_CONFIG_DEFAULTS.etaPublishDeltaMinutes,
): boolean {
  if (!previous) return true;
  return (
    Math.abs(previous.minMinutes - next.minMinutes) >= deltaMinutes ||
    Math.abs(previous.maxMinutes - next.maxMinutes) >= deltaMinutes
  );
}

export type { IntegrityConfig };
