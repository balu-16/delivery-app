export interface ManualAdjustmentInput {
  storeId: string;
  variantId: string;
  batchId: string;
  delta: string;
  expectedVersion: string;
  reason: string;
  reference: string;
}
export interface InventoryManualAdjustment {
  adjust(actor: string, input: ManualAdjustmentInput): Promise<{ approvalId?: string }>;
}
export const INVENTORY_MANUAL_ADJUSTMENT = Symbol('INVENTORY_MANUAL_ADJUSTMENT');
