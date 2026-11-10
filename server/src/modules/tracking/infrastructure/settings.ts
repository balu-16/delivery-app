import type { AppConfig } from '../../app-config/contracts/config.js';
import { type TrackingDefaultKey } from '../domain/eta.js';
import { INTEGRITY_DEFAULTS, type IntegrityConfig } from '../domain/integrity.js';

/** Typed app_config reads; invalid or unavailable configuration propagates. */
export class TrackingSettings {
  constructor(private readonly config: AppConfig) {}
  async number(key: TrackingDefaultKey): Promise<number> {
    const value = await this.config.get(key);
    if (typeof value !== 'number') throw new Error('INVALID_CONFIG_TYPE');
    return value;
  }
  async integrity(): Promise<IntegrityConfig> {
    const [
      maxBatchPoints,
      maxAccuracyMetres,
      maxSpeedMps,
      minPersistIntervalSeconds,
      minPersistDistanceMetres,
    ] = await Promise.all([
      this.number('locationMaxBatchPoints'),
      this.number('locationMaxAccuracyMetres'),
      this.number('locationMaxSpeedMps'),
      this.number('locationMinIntervalSeconds'),
      this.number('locationMinDistanceMetres'),
    ]);
    return {
      ...INTEGRITY_DEFAULTS,
      maxBatchPoints: Math.max(1, Math.trunc(maxBatchPoints)),
      maxAccuracyMetres,
      maxSpeedMps,
      minPersistIntervalSeconds,
      minPersistDistanceMetres,
    };
  }
  async eta() {
    const [roadFactor, avgSpeedKph, maxMinutes] = await Promise.all([
      this.number('etaRoadFactor'),
      this.number('etaAvgSpeedKph'),
      this.number('etaMaxMinutes'),
    ]);
    return { roadFactor, avgSpeedKph, maxMinutes };
  }
}
