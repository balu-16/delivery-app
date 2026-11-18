import type { CountInput } from './adjustments.js';
export const INVENTORY_ADMIN_CORRECTIONS = Symbol('INVENTORY_ADMIN_CORRECTIONS');
export interface AdminStockBatch {
  batchId: string;
  variantId: string;
  productName: string;
  variantName: string;
  batchCode: string;
  state: string;
  onHand: string;
  reserved: string;
  version: string;
}
export interface InventoryAdminCorrections {
  batches(
    actorId: string,
    storeId: string,
    cursor?: string,
  ): Promise<{ items: AdminStockBatch[]; nextCursor: string | null }>;
  correct(actorId: string, input: CountInput): Promise<void>;
}
