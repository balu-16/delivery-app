import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Substitution support (D13): the replacement quantity is atomically reserved
 * and committed while the same quantity of the original variant is released,
 * so a confirmed order never oversells and the aggregate reservation state is
 * preserved for pick resolution.
 */
export interface ReservationSwapInput {
  orderId: string;
  storeId: string;
  releaseVariantId: string;
  acquireVariantId: string;
  /** Whole saleable units moved from the released to the acquired variant. */
  quantity: string;
  targetDeliveryAt: string;
  /** Caller-provided idempotency reference (duplicated swaps apply once). */
  reference: string;
}

export const INVENTORY_SUBSTITUTION_SWAPS = Symbol('INVENTORY_SUBSTITUTION_SWAPS');
export interface InventorySubstitutionSwaps {
  swap(input: ReservationSwapInput, tx?: TransactionContext): Promise<void>;
}
