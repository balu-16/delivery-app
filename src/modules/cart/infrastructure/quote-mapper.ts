import { createHash } from 'node:crypto';
import type { PricingCouponInput, PricingTotals } from '../../pricing/contracts/pricing.js';
import { computeQuote } from '../../pricing/contracts/pricing.js';
import type { CouponPublic } from '../../coupons/contracts/coupons.js';
import type { QuoteFeeLine, QuoteIssue, QuoteLine, QuotePreview } from '../contracts/quote.js';
import type { EvaluatedCart } from './cart-evaluation.js';
import { moneyString } from '../../../common/money/money.js';

export function pricingCoupon(coupon: CouponPublic): PricingCouponInput {
  return {
    kind: coupon.kind,
    value: BigInt(coupon.valuePaise),
    maxCapPaise: coupon.maxCapPaise === null ? null : BigInt(coupon.maxCapPaise),
  };
}
/** Binds the applied coupon definition into the snapshot for later re-validation. */
export function couponFingerprint(coupon: CouponPublic): string {
  return createHash('sha256').update(JSON.stringify(coupon)).digest('hex');
}
export function computeCartQuote(
  evaluation: EvaluatedCart,
  coupon: CouponPublic | null,
  tipPaise: bigint,
  wallet: {
    promoAvailablePaise: bigint;
    cashAvailablePaise: bigint;
    promoSpendCapBps: number;
  } | null,
): PricingTotals {
  return computeQuote({
    lines: evaluation.lines
      .filter((line) => line.saleable)
      .map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPricePaise: line.freshUnitPricePaise!,
        mrpPaise: line.mrpPaise,
        taxRateBps: line.taxRateBps,
        eligibleForDiscount:
          coupon !== null &&
          !(coupon.excludedVariantIds ?? []).includes(line.variantId) &&
          (coupon.categoryId == null || coupon.categoryId === line.categoryId) &&
          (coupon.productId == null || coupon.productId === line.productId),
      })),
    coupon: coupon === null ? null : pricingCoupon(coupon),
    tipPaise,
    fees: evaluation.fees,
    wallet,
    minOrderPaise: evaluation.minOrderPaise,
    maxOrderPaise: evaluation.maxOrderPaise,
  });
}
export function quoteIssues(totals: PricingTotals): QuoteIssue[] {
  const issues: QuoteIssue[] = [];
  if (totals.minOrderNotMet)
    issues.push({
      code: 'MIN_ORDER_NOT_MET',
      detail: 'order value is below the configured minimum',
    });
  if (totals.maxOrderExceeded)
    issues.push({
      code: 'MAX_ORDER_EXCEEDED',
      detail: 'order value exceeds the configured maximum',
    });
  return issues;
}
export function toQuoteLines(totals: PricingTotals, storeId: string): QuoteLine[] {
  return totals.lines.map((line) => ({
    variantId: line.variantId,
    storeId,
    quantity: moneyString(line.quantity),
    unitPricePaise: moneyString(line.unitPricePaise),
    mrpPaise: moneyString(line.mrpPaise),
    lineSubtotalPaise: moneyString(line.lineSubtotalPaise),
    discountPaise: moneyString(line.discountPaise),
    taxRateBps: line.taxRateBps,
    taxPaise: moneyString(line.taxPaise),
    lineTotalPaise: moneyString(line.lineTotalPaise),
  }));
}
export function toQuoteFees(totals: PricingTotals): QuoteFeeLine[] {
  return totals.fees.map((fee) => ({
    kind: fee.kind,
    amountPaise: moneyString(fee.amountPaise),
    taxPaise: moneyString(fee.taxPaise),
    taxSplit: fee.taxSplit,
  }));
}
export function toPreview(
  evaluation: EvaluatedCart,
  totals: PricingTotals,
  coupon: CouponPublic | null,
  couponIssue: QuoteIssue | null,
): QuotePreview {
  return {
    cartId: evaluation.cart.id,
    cartVersion: Number(evaluation.cart.version),
    storeId: evaluation.cart.store_id,
    addressId: evaluation.cart.address_id,
    lines: toQuoteLines(totals, evaluation.cart.store_id),
    fees: toQuoteFees(totals),
    couponCode: coupon?.code ?? null,
    couponDiscountPaise: moneyString(totals.couponDiscountPaise),
    subtotalPaise: moneyString(totals.subtotalPaise),
    discountPaise: moneyString(totals.discountPaise),
    feeTotalPaise: moneyString(totals.feeTotalPaise),
    taxTotalPaise: moneyString(totals.taxTotalPaise),
    tipPaise: moneyString(totals.tipPaise),
    totalPaise: moneyString(totals.totalPaise),
    wallet: totals.wallet
      ? {
          promoPaise: moneyString(totals.wallet.promoPaise),
          cashPaise: moneyString(totals.wallet.cashPaise),
        }
      : null,
    amountDuePaise: moneyString(totals.amountDuePaise),
    priceVersion: evaluation.priceVersion,
    configVersion: evaluation.configVersion,
    couponFingerprint: coupon ? couponFingerprint(coupon) : null,
    issues: [...evaluation.issues, ...(couponIssue ? [couponIssue] : []), ...quoteIssues(totals)],
  };
}
