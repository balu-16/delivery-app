export interface StoreStatusInput {
  storeId: string;
  actorId: string;
  status: 'ONLINE' | 'PAUSED';
  reason?: string;
  admin: boolean;
  correlationId: string;
}
export interface StoreManagement {
  setStatus(input: StoreStatusInput): Promise<void>;
}

/** Store facts + operating hours for the store-manager portal. */
export interface StoreDetailsView {
  storeId: string;
  name: string;
  status: 'ONLINE' | 'PAUSED' | 'OFFLINE';
  pauseReason: string | null;
  version: string;
  /** Business timezone coordinates of the store pin, when present. */
  location: { lat: number; lng: number } | null;
  hourlyCapacity: number;
  lastOrderBufferMinutes: number;
  hours: { weekday: number; startMinute: number; endMinute: number }[];
  /** Whether this actor may pause the store under the current status policy. */
  canPause: boolean;
  /** Whether this actor may resume the store (manager-controlled pauses only). */
  canResume: boolean;
  /** Stable reason explaining the disabled control. */
  restrictionReason: 'STORE_NOT_ONLINE' | 'STORE_NOT_PAUSED' | 'PAUSE_MANAGED_BY_ADMIN';
}

export interface StoreStatusHistoryEntry {
  version: string;
  previousStatus: string;
  status: string;
  reason: string | null;
  actorId: string | null;
  occurredAt: string;
  /** Control domain that wrote the row; NULL = legacy (treated as admin-controlled). */
  source: 'ADMIN' | 'MANAGER' | 'SYSTEM' | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Store-scoped reads for the store-manager portal. Every call re-checks the
 * caller's STORE_MANAGER assignment for the requested store.
 */
export interface StorePortalStoreReads {
  details(actorId: string, storeId: string): Promise<StoreDetailsView>;
  statusHistory(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<StoreStatusHistoryEntry>>;
}

export const STORE_PORTAL_STORE_READS = Symbol('STORE_PORTAL_STORE_READS');
