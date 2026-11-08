import {
  normalizeCode,
  type CouponDraft,
  type CouponKind,
  type CouponPatch,
  type CouponValidationInput,
} from '../contracts/coupons.js';
export { normalizeCode };
export function parsePaise(raw: string, label: string): bigint {
  if (!/^[0-9]{1,18}$/.test(raw)) throw new Error(`INVALID_MONEY:${label}`);
  return BigInt(raw);
}
export function parseCouponValue(kind: CouponKind, valuePaise: string): bigint {
  const value = parsePaise(valuePaise, 'value');
  if (kind === 'PERCENT' && (value < 1n || value > 10000n)) throw new Error('INVALID_INPUT');
  if (kind === 'FLAT' && value <= 0n) throw new Error('INVALID_INPUT');
  if (kind === 'FREE_DELIVERY' && value !== 0n) throw new Error('INVALID_INPUT');
  return value;
}
export function parseInstant(raw: string | null, label: string): Date | null {
  if (raw === null) return null;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`INVALID_INPUT:${label}`);
  return date;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseCouponDraft(draft: CouponDraft): void {
  normalizeCode(draft.code);
  if (!['PERCENT', 'FLAT', 'FREE_DELIVERY'].includes(draft.kind)) throw new Error('INVALID_INPUT');
  parseCouponValue(draft.kind, draft.valuePaise);
  parsePaise(draft.minOrderPaise, 'minOrder');
  if (draft.maxCapPaise !== null && parsePaise(draft.maxCapPaise, 'maxCap') <= 0n)
    throw new Error('INVALID_INPUT');
  for (const key of ['perUserLimit', 'globalLimit'] as const) {
    const limit = draft[key];
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error('INVALID_INPUT');
  }
  const from = parseInstant(draft.validFrom, 'validFrom');
  const to = parseInstant(draft.validTo, 'validTo');
  if (from && to && to.getTime() <= from.getTime()) throw new Error('INVALID_INPUT:window');
  for (const id of [draft.storeId, draft.categoryId, draft.productId])
    if (id !== null && !UUID.test(id)) throw new Error('INVALID_INPUT:scope');
  if (
    !Array.isArray(draft.excludedVariantIds) ||
    draft.excludedVariantIds.some((id) => !UUID.test(id))
  )
    throw new Error('INVALID_INPUT:exclusions');
  if (typeof draft.stackable !== 'boolean' || typeof draft.firstOrderOnly !== 'boolean')
    throw new Error('INVALID_INPUT');
}
/** Whitelisted, validated PATCH projection; unknown fields never reach storage. */
export function parseCouponPatch(patch: CouponPatch): CouponPatch {
  const result: CouponPatch = {};
  for (const key of ['perUserLimit', 'globalLimit'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value !== null && (!Number.isSafeInteger(value) || value < 1))
      throw new Error('INVALID_INPUT');
    result[key] = value;
  }
  for (const key of ['validFrom', 'validTo'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    parseInstant(value, key);
    result[key] = value;
  }
  if (patch.minOrderPaise !== undefined) {
    parsePaise(patch.minOrderPaise, 'minOrder');
    result.minOrderPaise = patch.minOrderPaise;
  }
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new Error('INVALID_INPUT');
    result.active = patch.active;
  }
  return result;
}
export interface CouponRuleRow {
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  minOrderPaise: string;
  storeId: string | null;
  categoryId: string | null;
  productId: string | null;
  excludedVariantIds: string[];
}
/**
 * Pure subset of coupon rules: state, validity window (UTC instants evaluated
 * at database time), store scope, minimum order and remaining eligible lines.
 */
export function checkCouponRules(
  coupon: CouponRuleRow,
  now: Date,
  input: Pick<CouponValidationInput, 'storeId' | 'lines' | 'subtotalPaise'>,
): void {
  if (!coupon.active) throw new Error('COUPON_INVALID');
  if (
    (coupon.validFrom !== null && now < new Date(coupon.validFrom)) ||
    (coupon.validTo !== null && now >= new Date(coupon.validTo))
  )
    throw new Error('COUPON_EXPIRED');
  if (coupon.storeId !== null && coupon.storeId !== input.storeId)
    throw new Error('COUPON_NOT_ELIGIBLE');
  if (input.subtotalPaise < parsePaise(coupon.minOrderPaise, 'minOrder'))
    throw new Error('COUPON_NOT_ELIGIBLE');
  const eligible = eligibleLines(input.lines, coupon, coupon.excludedVariantIds);
  if (eligible.length === 0) throw new Error('COUPON_NOT_ELIGIBLE');
}
export function eligibleLines(
  lines: CouponValidationInput['lines'],
  scope: { categoryId: string | null; productId: string | null },
  excludedVariantIds: string[],
): CouponValidationInput['lines'] {
  const excluded = new Set(excludedVariantIds);
  return lines.filter((line) => {
    if (excluded.has(line.variantId)) return false;
    if (scope.categoryId !== null && line.categoryId !== scope.categoryId) return false;
    if (scope.productId !== null && line.productId !== scope.productId) return false;
    return line.quantity > 0n;
  });
}
