import { ApiError } from '../api/client';

export const ORDER_CONFIRMATION_WAIT = 'Please wait while we confirm your order.';
export type CheckoutPhase = 'idle' | 'reviewing' | 'placing' | 'checking' | 'uncertain';

/** Only errors that prove the placement was rejected may release its saved key. */
export function isDefinitivePlacementError(error: unknown): boolean {
  return error instanceof ApiError && [
    'COD_NOT_ELIGIBLE', 'COD_LIMIT_EXCEEDED', 'PRICE_CHANGED', 'QUOTE_EXPIRED',
    'CONCURRENT_MODIFICATION', 'INVENTORY_INSUFFICIENT', 'ITEM_UNAVAILABLE',
    'ADDRESS_NOT_SERVICEABLE', 'ADDRESS_LOCATION_REQUIRED', 'CART_NOT_FOUND',
    'WALLET_INSUFFICIENT', 'WALLET_DISABLED', 'COUPON_INVALID',
    'MIN_ORDER_NOT_MET', 'MAX_ORDER_EXCEEDED',
  ].includes(error.code);
}

export function recoveryDelay(attempt: number): number {
  return [1000, 2000, 4000, 8000, 15000][Math.min(attempt, 4)];
}
