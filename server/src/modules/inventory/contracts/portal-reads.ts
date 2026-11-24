/**
 * Store-portal inventory history reads (P10). Every method is store-scoped:
 * the actor must hold STORE_MANAGER on the target store, otherwise the read
 * fails with RESOURCE_NOT_FOUND (store existence is never leaked). Money and
 * quantities are canonical decimal strings; timestamps serialize as ISO.
 */
export interface InventoryReceiptItem {
  id: string;
  reference: string;
  variantId: string;
  variantName: string;
  sku: string;
  batchId: string;
  batchCode: string;
  expiresAt: Date | null;
  quantity: string;
  actorId: string | null;
  actorName: string | null;
  createdAt: Date;
}
export interface InventoryReceiptPage {
  items: InventoryReceiptItem[];
  nextCursor: string | null;
}

/**
 * One manual-adjustment row: counted is the absolute on-hand the actor
 * recorded; delta is the applied ledger movement (null while an approval is
 * still pending or was rejected). State mirrors the compliance approval:
 * APPLIED when no checker was required (or one executed), PENDING/EXPIRED/
 * REJECTED come straight from maker_checker_requests.
 */
export interface InventoryAdjustmentItem {
  reference: string;
  counted: string;
  delta: string | null;
  variantId: string | null;
  variantName: string | null;
  batchId: string | null;
  batchCode: string | null;
  reason: string | null;
  actorId: string;
  actorName: string | null;
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'APPLIED';
  approvalId: string | null;
  createdAt: Date;
}
export interface InventoryAdjustmentPage {
  items: InventoryAdjustmentItem[];
  nextCursor: string | null;
}

export interface InventoryCountItem {
  variantId: string | null;
  variantName: string | null;
  batchId: string | null;
  batchCode: string | null;
  counted: string | null;
  reason: string | null;
}
export interface InventoryCountEntry {
  actorId: string;
  actorName: string | null;
  reference: string;
  state: 'APPLIED' | 'PENDING' | 'EXPIRED' | 'REJECTED';
  approvalRequired: boolean;
  items: InventoryCountItem[];
  createdAt: Date;
  completedAt: Date | null;
}
export interface InventoryCountPage {
  items: InventoryCountEntry[];
  nextCursor: string | null;
}

export interface InventoryBatchItem {
  batchId: string;
  variantId: string;
  sku: string;
  name: string;
  batchCode: string;
  expiresAt: Date | null;
  state: string;
  onHand: string;
  reserved: string;
  available: string;
  binLocation: string | null;
  /** store_inventory optimistic-concurrency version for manual adjustments. */
  version: string;
}
export interface InventoryBatchPage {
  items: InventoryBatchItem[];
  nextCursor: string | null;
  /**
   * Server-side approval threshold (`inventoryAdjustmentApprovalUnits`):
   * absolute deltas up to and including this value apply immediately, larger
   * ones wait for admin approval. The server re-reads it at submit time, so
   * this value explains the rule without being the submit authority.
   */
  inventoryAdjustmentApprovalUnits: number;
}

/** Same row shape as InventoryManagement.list, unpaginated with a hard cap. */
export interface InventoryExportItem {
  variantId: string;
  binLocation: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  onHand: string;
  reserved: string;
  available: string;
  version: string;
}
export interface InventoryExportResult {
  items: InventoryExportItem[];
  truncated: boolean;
}

export const INVENTORY_PORTAL_READS = Symbol('INVENTORY_PORTAL_READS');
export interface InventoryPortalReads {
  receipts(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryReceiptPage>;
  adjustments(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryAdjustmentPage>;
  counts(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryCountPage>;
  batches(
    actorId: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryBatchPage>;
  exportStock(actorId: string, storeId: string, search: string): Promise<InventoryExportResult>;
}
