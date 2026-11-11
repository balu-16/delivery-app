import type { TransactionContext } from '../../../platform/database/database.js';
export interface QuoteIssue {
  code:
    | 'ITEM_UNAVAILABLE'
    | 'PRICE_CHANGED'
    | 'QTY_REDUCED'
    | 'COUPON_INVALID'
    | 'MIN_ORDER_NOT_MET'
    | 'MAX_ORDER_EXCEEDED';
  variantId?: string;
  detail?: string;
}
export interface QuoteLine {
  variantId: string;
  storeId: string;
  quantity: string;
  unitPricePaise: string;
  mrpPaise: string;
  lineSubtotalPaise: string;
  discountPaise: string;
  taxRateBps: number;
  taxPaise: string;
  lineTotalPaise: string;
}
export interface QuoteFeeLine {
  kind: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE' | 'TIP';
  amountPaise: string;
  taxPaise: string;
  taxSplit: 'CGST_SGST' | 'IGST' | null;
}
export interface QuoteWalletApplication {
  promoPaise: string;
  cashPaise: string;
}
export interface QuoteSnapshot {
  quoteId: string;
  cartId: string;
  cartVersion: number;
  userId: string;
  storeId: string;
  addressId: string;
  referralClaimId: string | null;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED';
  lines: QuoteLine[];
  fees: QuoteFeeLine[];
  couponCode: string | null;
  couponDiscountPaise: string;
  subtotalPaise: string;
  discountPaise: string;
  feeTotalPaise: string;
  taxTotalPaise: string;
  tipPaise: string;
  totalPaise: string;
  wallet: QuoteWalletApplication | null;
  amountDuePaise: string;
  priceVersion: string;
  configVersion: string;
  couponFingerprint: string | null;
  expiresAt: string;
  createdAt: string;
  issues: QuoteIssue[];
}
export interface WalletBalanceInput {
  promoAvailablePaise: string;
  cashAvailablePaise: string;
  promoSpendCapBps: number;
}
export const CART_QUOTES = Symbol('CART_QUOTES');
export interface CartQuotes {
  /** Re-price current cart at fresh prices/config; persist expiring snapshot (default TTL = paymentWindowSeconds); supersede prior ACTIVE quotes. */
  refresh(input: {
    userId: string;
    addressId: string;
    tipPaise?: string;
    couponCode?: string | null;
    wallet?: WalletBalanceInput;
    /** Join the caller's placement transaction instead of opening one. */
    tx?: TransactionContext;
  }): Promise<QuoteSnapshot>;
  get(quoteId: string, userId: string, tx?: TransactionContext): Promise<QuoteSnapshot>;
  markConsumed(quoteId: string, tx?: TransactionContext): Promise<void>;
}
/** Non-persisting computed quote used by POST /cart/validate. */
export interface QuotePreview {
  cartId: string;
  cartVersion: number;
  storeId: string;
  addressId: string;
  referralClaimId: string | null;
  lines: QuoteLine[];
  fees: QuoteFeeLine[];
  couponCode: string | null;
  couponDiscountPaise: string;
  subtotalPaise: string;
  discountPaise: string;
  feeTotalPaise: string;
  taxTotalPaise: string;
  tipPaise: string;
  totalPaise: string;
  wallet: QuoteWalletApplication | null;
  amountDuePaise: string;
  priceVersion: string;
  configVersion: string;
  couponFingerprint: string | null;
  issues: QuoteIssue[];
}
export const CART_PREVIEWS = Symbol('CART_PREVIEWS');
export interface CartPreviews {
  /** Compute the quote preview without persisting a snapshot. */
  preview(input: {
    userId: string;
    addressId: string;
    tipPaise?: string;
    couponCode?: string | null;
    /** Join the caller's transaction instead of opening one. */
    tx?: TransactionContext;
  }): Promise<QuotePreview>;
}
