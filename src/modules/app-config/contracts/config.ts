export const INVENTORY_CONFIG_DEFAULTS = {
  catalogLowStockThreshold: 5,
  inventoryExpirySoonDays: 7,
} as const;
/** Fee slabs are ascending order-value ceilings; the last slab may use null for "above". */
export interface DeliveryFeeSlab {
  maxOrderValuePaise: string | null;
  feePaise: string;
}
export interface CodEligibility {
  minCompletedPrepaidOrders: number;
}
export interface FeeTaxRule {
  appliesTo: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE' | 'ALL';
  taxBps: number;
  split: 'CGST_SGST' | 'IGST';
}
export interface ConfigValues {
  inventoryReservationTtlSeconds: number;
  inventoryAdjustmentApprovalUnits: number;
  inventoryExpirySoonDays: number;
  catalogLowStockThreshold: number;
  catalogMaxPerOrder: number;
  catalogAllowedGstBps: number[];
  maxCartLines: number;
  minOrderPaise: string;
  maxOrderPaise: string;
  maxCodPaise: string;
  deliveryFeeSlabs: DeliveryFeeSlab[];
  freeDeliveryThresholdPaise: string;
  handlingFeePaise: string;
  smallCartThresholdPaise: string;
  smallCartFeePaise: string;
  surgeFeePaise: string;
  paymentWindowSeconds: number;
  couponValidationAttemptsPerWindow: number;
  refundDestinationPolicy: 'original' | 'original_then_wallet' | 'wallet';
  promoSpendCapBps: number;
  topupMinPaise: string;
  topupMaxPaise: string;
  topupMonthlyCapPaise: string;
  codEligibility: CodEligibility;
  feeTaxRules: FeeTaxRule[];
  catalogPriceApprovalCount: number;
  catalogPriceApprovalPercent: number;
  catalogImportMaxBytes: number;
  catalogImportMaxRows: number;
  catalogImportBatchSize: number;
  catalogSuggestCacheSeconds: number;
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
  pickingSlaMinutes: number;
  maxActivePickTasksPerPicker: number;
  handoverMaxAttempts: number;
  handoverLockoutSeconds: number;
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
