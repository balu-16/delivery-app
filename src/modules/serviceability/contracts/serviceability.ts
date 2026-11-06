export type ServiceabilityReason =
  'OUTSIDE_ZONE' | 'STORE_CLOSED' | 'STORE_PAUSED' | 'STORE_AT_CAPACITY' | 'NO_RIDERS_AVAILABLE';
export interface ZoneSnapshot {
  zoneId: string;
  zoneVersion: string;
  cityZoneVersion: string;
  storeId: string;
}
export interface ServiceabilityResult {
  serviceable: boolean;
  storeId: string | null;
  zone: ZoneSnapshot | null;
  etaRange: { minMinutes: number; maxMinutes: number } | null;
  reasons: ServiceabilityReason[];
}
export interface ServiceabilityInput {
  lat: number;
  lng: number;
  targetTime: Date;
}
export interface Serviceability {
  check(input: ServiceabilityInput): Promise<ServiceabilityResult>;
}
export interface CapacityClaims {
  /** Claim within the caller's business transaction in the eventual checkout integration. */
  claim(
    storeId: string,
    slotStart: Date,
    reference: string,
  ): Promise<'CLAIMED' | 'ALREADY_CLAIMED' | 'AT_CAPACITY'>;
}
