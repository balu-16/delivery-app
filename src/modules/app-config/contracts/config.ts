export interface ConfigValues {
  addressMaxPerUser: number;
  addressPinMismatchMetres: number;
  zoneMinAreaM2: number;
  zoneMaxAreaM2: number;
  mapCacheTtlSeconds: number;
  mapMatrixTopK: number;
  mapMatrixMaxPairs: number;
  mapFallbackSpeedKph: number;
  storeBacklogPauseThreshold: number;
  storeNoRidersPauseMinutes: number;
  etaMinMinutes: number;
  etaMaxMinutes: number;
  requiredRiderDocuments: string[];
  termsVersion: string;
  privacyVersion: string;
  maxPauseLengthDays: number;
}
export type ConfigKey = keyof ConfigValues;
export interface AppConfig {
  get<K extends ConfigKey>(key: K): Promise<ConfigValues[K]>;
}
export const APP_CONFIG = Symbol('APP_CONFIG');

export const FEATURE_FLAG_KEYS = [
  'wallet_enabled',
  'cod_enabled',
  'subscriptions_enabled',
  'auto_substitution',
  'reinstate_expired_orders',
  'surge_enabled',
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];
export interface AdminConfig {
  snapshot(): Promise<{ config: ConfigValues; flags: Record<FeatureFlagKey, boolean> }>;
  update(actorId: string, key: ConfigKey, value: unknown): Promise<void>;
  setFlag(actorId: string, key: FeatureFlagKey, enabled: boolean): Promise<void>;
}
export const ADMIN_CONFIG = Symbol('ADMIN_CONFIG');
