/** Internal P7 boundary: a return is quarantined until an authorized QC decision. */
export interface ReturnReceipt {
  returnId: string;
  orderId: string;
  storeId: string;
  variantId: string;
  quantity: string;
  expiresAt: string | null;
}
export interface InventoryReturns {
  receiveReturn(actor: string, input: ReturnReceipt): Promise<void>;
  inspectReturn(
    actor: string,
    returnId: string,
    result: 'APPROVE' | 'REJECT',
    reason: string,
  ): Promise<void>;
}
export const INVENTORY_RETURNS = Symbol('INVENTORY_RETURNS');
