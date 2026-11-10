import type { TransactionContext } from '../../../platform/database/database.js';
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
  /** Shared cancellation only: recover already-picked warehouse goods into quarantine. */
  receiveCancelledOrder(
    orderId: string,
    actorId: string | null,
    tx: TransactionContext,
  ): Promise<void>;
  receiveReturn(actor: string, input: ReturnReceipt, tx?: TransactionContext): Promise<void>;
  inspectReturn(
    actor: string,
    returnId: string,
    result: 'APPROVE' | 'REJECT',
    reason: string,
  ): Promise<void>;
}
export const INVENTORY_RETURNS = Symbol('INVENTORY_RETURNS');
