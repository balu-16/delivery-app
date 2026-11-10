export interface CountInput {
  storeId: string;
  variantId: string;
  batchId: string;
  counted: string;
  expectedVersion: string;
  reason: string;
  reference: string;
  kind?: 'ADJUSTMENT';
}
export interface InventoryAdjustments {
  count(actor: string, input: CountInput): Promise<{ approvalId?: string }>;
  approve(actor: string, approvalId: string, reference: string): Promise<void>;
}
export const INVENTORY_ADJUSTMENTS = Symbol('INVENTORY_ADJUSTMENTS');
