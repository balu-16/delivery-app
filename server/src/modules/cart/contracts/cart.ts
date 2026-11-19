import type { TransactionContext } from '../../../platform/database/database.js';
import type { QuoteIssue } from './quote.js';
export interface CartLineView {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  image: string | null;
  quantity: string;
  unitPricePaise: string;
  currentUnitPricePaise: string | null;
  mrpPaise: string;
  lineSubtotalPaise: string;
}
export interface CartView {
  cartId: string;
  userId: string;
  storeId: string | null;
  addressId: string | null;
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
  /** Reject a stale catalog price rather than silently charging a different one. */
  displayedUnitPricePaise?: string;
  /** Explicit customer approval of the current price of an existing line. */
  acceptPriceChange?: boolean;
  /** Require the full confirmed quantity to be available at the cart's store. */
  requireAvailableQuantity?: boolean;
  /** Join the caller's transaction (idempotent HTTP execution) instead of opening one. */
  tx?: TransactionContext;
}
export const CART_SERVICE = Symbol('CART_SERVICE');
export interface CartService {
  /** Resolve the single active cart; an optional address rebinds it to that store. */
  getOrCreateActiveCart(
    userId: string,
    addressId: string | undefined,
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
