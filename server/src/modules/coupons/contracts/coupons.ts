import type { TransactionContext } from '../../../platform/database/database.js';
export type CouponKind = 'PERCENT' | 'FLAT' | 'FREE_DELIVERY';
/** Codes are trimmed and case-insensitive; storage is uppercase. Shared contract helper. */
export function normalizeCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(code)) throw new Error('INVALID_COUPON_CODE');
  return code;
}
export interface CouponPublic {
  code: string;
  kind: CouponKind;
  valuePaise: string;
  maxCapPaise: string | null;
  minOrderPaise: string;
  categoryId?: string | null;
  productId?: string | null;
  excludedVariantIds?: readonly string[];
  version?: string;
}
export const COUPON_REDEMPTIONS = Symbol('COUPON_REDEMPTIONS');
export interface CouponRedemptions {
  /** Atomic global+per-user quota reservation inside caller's tx; throws COUPON_EXHAUSTED / COUPON_LIMIT_REACHED / COUPON_* on failure. */
  reserve(
    code: string,
    userId: string,
    tx: TransactionContext,
  ): Promise<string /* reservationId */>;
  commit(reservationId: string, orderId: string, tx?: TransactionContext): Promise<void>;
  release(reservationId: string, tx?: TransactionContext): Promise<void>;
}
export interface CouponValidationInput {
  userId: string;
  code: string;
  storeId: string;
  lines: {
    variantId: string;
    productId: string;
    categoryId: string | null;
    quantity: bigint;
    unitPricePaise: bigint;
  }[];
  subtotalPaise: bigint;
  tx?: TransactionContext;
}
export const COUPONS = Symbol('COUPONS');
export interface CouponValidation {
  validate(input: CouponValidationInput): Promise<{ coupon: CouponPublic }>;
  available(userId: string, storeId: string, subtotalPaise: bigint): Promise<CouponPublic[]>;
}
/**
 * First-order eligibility is derived from the authoritative orders source of
 * truth, never from a client-provided flag. P6 owns the orders tables; until
 * they exist the guarded implementation treats every account as first-order.
 */
export interface FirstOrderCheck {
  /** True when the user has no completed (delivered) order; true while orders tables are absent. */
  isFirstOrder(userId: string, tx?: TransactionContext): Promise<boolean>;
}
export const FIRST_ORDER_CHECK = Symbol('FIRST_ORDER_CHECK');
export interface CouponDraft {
  code: string;
  kind: CouponKind;
  valuePaise: string;
  maxCapPaise: string | null;
  minOrderPaise: string;
  perUserLimit: number | null;
  globalLimit: number | null;
  validFrom: string | null;
  validTo: string | null;
  storeId: string | null;
  categoryId: string | null;
  productId: string | null;
  excludedVariantIds: string[];
  stackable: boolean;
  firstOrderOnly: boolean;
}
export interface CouponPatch {
  perUserLimit?: number | null;
  globalLimit?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  minOrderPaise?: string;
  active?: boolean;
}
export interface CouponAdminView extends CouponPublic {
  id: string;
  perUserLimit: number | null;
  globalLimit: number | null;
  redeemedCount: number;
  validFrom: string | null;
  validTo: string | null;
  storeId: string | null;
  categoryId: string | null;
  productId: string | null;
  excludedVariantIds: string[];
  stackable: boolean;
  firstOrderOnly: boolean;
  active: boolean;
  version: string;
}
export const COUPON_ADMINISTRATION = Symbol('COUPON_ADMINISTRATION');
export interface CouponAdministration {
  /** Creates an audited coupon; joins the caller's transaction when provided. */
  create(actorId: string, draft: CouponDraft, tx?: TransactionContext): Promise<CouponAdminView>;
  list(
    actorId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: CouponAdminView[]; nextCursor: string | null }>;
  update(
    actorId: string,
    id: string,
    patch: CouponPatch,
    expectedVersion: string,
    tx?: TransactionContext,
  ): Promise<CouponAdminView>;
}
/** Rate-limits coupon code validation attempts per user (code guessing). */
export const COUPON_ATTEMPT_LIMITER = Symbol('COUPON_ATTEMPT_LIMITER');
export interface CouponAttemptLimiter {
  /** Fails open when the limiter is unavailable; throws HTTP 429 when exceeded. */
  check(userId: string): Promise<void>;
}
