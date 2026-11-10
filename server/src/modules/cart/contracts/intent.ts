import type { TransactionContext } from '../../../platform/database/database.js';
export const CART_INTENTS = Symbol('CART_INTENTS');
export interface CartIntents {
  issue(
    cartId: string,
    cartVersion: number,
    quoteId: string,
  ): Promise<{ intentId: string; expiresAt: string }>;
  /** Atomically consume in the caller's placement tx; second consume (even different idempotency key) throws CART_INTENT_CONSUMED. */
  consume(
    intentId: string,
    expected: { cartId: string; cartVersion: number; quoteId: string },
    tx: TransactionContext,
  ): Promise<void>;
}
