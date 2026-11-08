import type { TransactionContext } from '../../../platform/database/database.js';
import type { QuoteIssue } from './quote.js';
export interface CartLineView {
  variantId: string;
  quantity: string;
  unitPricePaise: string;
  mrpPaise: string;
  lineSubtotalPaise: string;
}
export interface CartView {
  cartId: string;
  userId: string;
  storeId: string;
  addressId: string;
  version: number;
  couponCode: string | null;
  lines: CartLineView[];
  issues: QuoteIssue[];
}
export interface CartWriteResult {
  cart: CartView;
  /** Clamped writes surface what changed; lines are never silently dropped. */
  clamped: boolean;
}
export interface CartMutationOptions {
  /** Optimistic concurrency guard; a stale version conflicts (CONCURRENT_MODIFICATION). */
  expectedVersion: number;
  /** Establishes the first cart at this address's store when the user has none. */
  addressId?: string;
  /** Join the caller's transaction (idempotent HTTP execution) instead of opening one. */
  tx?: TransactionContext;
}
export const CART_SERVICE = Symbol('CART_SERVICE');
export interface CartService {
  /** Resolve the single active cart for the user; rebinds store when the address moved stores. */
  getOrCreateActiveCart(
    userId: string,
    addressId: string,
    tx?: TransactionContext,
  ): Promise<CartView>;
  /** Read-only view with freshly computed issues; never mutates the cart. */
  get(userId: string, tx?: TransactionContext): Promise<CartView | null>;
  /** Fresh saleable subtotal and bound store, for coupon availability reads. */
  freshSubtotal(
    userId: string,
    addressId?: string,
  ): Promise<{ storeId: string; subtotalPaise: bigint } | null>;
  /** Absolute quantity write; clamps to per-order limits and available stock. */
  putItem(
    userId: string,
    variantId: string,
    quantity: string,
    opts: CartMutationOptions,
  ): Promise<CartWriteResult>;
  deleteItem(userId: string, variantId: string, opts: CartMutationOptions): Promise<CartView>;
  deleteCart(userId: string, opts: CartMutationOptions): Promise<void>;
  applyCoupon(userId: string, code: string, opts: CartMutationOptions): Promise<CartView>;
  removeCoupon(userId: string, opts: CartMutationOptions): Promise<CartView>;
}
