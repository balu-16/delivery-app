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
   * With `orderId`: the order's own allocated batches per variant, FEFO
   * ordered — the batches the picker must scan. Without it: earliest-expiry
   * eligible surplus batches per variant (state, on-hand surplus and
   * category shelf life at the target delivery time). Expired, quarantined
   * and damaged batches are never suggested.
   */
  suggest(input: {
    storeId: string;
    variantIds: string[];
    targetDeliveryAt: string;
    orderId?: string;
    limit?: number;
  }): Promise<Map<string, FefoBatch[]>>;
}
