import type { TransactionContext } from '../../../platform/database/database.js';

export type ServiceabilityTransaction = TransactionContext;

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
  check(input: ServiceabilityInput, tx?: TransactionContext): Promise<ServiceabilityResult>;
}
export interface CapacityClaims {
  /** Claim within the caller's business transaction in the eventual checkout integration. */
  claim(
    storeId: string,
    slotStart: Date,
    reference: string,
    tx?: TransactionContext,
  ): Promise<'CLAIMED' | 'ALREADY_CLAIMED' | 'AT_CAPACITY'>;
  /** Release all outstanding capacity claimed by this business reference once. */
  release(reference: string, tx?: TransactionContext): Promise<boolean>;
}
