export interface BatchQualityInput {
  storeId: string;
  variantId: string;
  batchId: string;
  state: 'QUARANTINED' | 'DAMAGED';
  reason: string;
  reference: string;
}
export interface InventoryQuality {
  setState(actor: string, input: BatchQualityInput): Promise<void>;
}
export const INVENTORY_QUALITY = Symbol('INVENTORY_QUALITY');
