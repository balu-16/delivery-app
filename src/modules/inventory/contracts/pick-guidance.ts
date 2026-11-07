/** Pick-time batch guidance (P7): FEFO suggestions reuse reservation eligibility rules. */
export interface FefoBatch {
  batchId: string;
  batchCode: string;
  expiresAt: string | null;
  availableQty: string;
}

export const INVENTORY_PICK_GUIDANCE = Symbol('INVENTORY_PICK_GUIDANCE');
export interface InventoryPickGuidance {
  /**
   * Earliest-expiry eligible batches per variant, filtered by state, on-hand
   * surplus and category shelf life at the target delivery time. Expired,
   * quarantined and damaged batches are never suggested.
   */
  suggest(input: {
    storeId: string;
    variantIds: string[];
    targetDeliveryAt: string;
    limit?: number;
  }): Promise<Map<string, FefoBatch[]>>;
}
