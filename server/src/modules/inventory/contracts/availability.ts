/** Stable assortment/availability boundary; P4 adds ledger-backed mutation implementations. */
export interface InventoryAvailability {
  storeId: string;
  variantId: string;
  onHand: string;
  reserved: string;
  /** Immediately saleable quantity excludes expired and quarantined batches. */
  available: string;
  version: string;
}
export const INVENTORY_AVAILABILITY = Symbol('INVENTORY_AVAILABILITY');
export interface InventoryAvailabilityQuery {
  get(storeId: string, variantId: string): Promise<InventoryAvailability | null>;
}
