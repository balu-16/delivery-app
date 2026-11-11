import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import { parseMoney } from '../../../common/money/money.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CouponPublic, CouponValidation } from '../../coupons/contracts/coupons.js';
import type { QuoteIssue, QuotePreview, WalletBalanceInput } from '../contracts/quote.js';
import { advisoryLockCart, getOrCreateCartRow } from './cart-store.js';
import { evaluateCart, type EvaluatedCart } from './cart-evaluation.js';
import { computeCartQuote, toPreview } from './quote-mapper.js';
export function parseTip(raw: string | undefined): bigint {
  if (raw === undefined) return 0n;
  const value = parseMoney(raw);
  if (value < 0n) throw new Error('INVALID_MONEY');
  return value;
}
export function parseWallet(
  wallet: WalletBalanceInput | undefined,
): { promoAvailablePaise: bigint; cashAvailablePaise: bigint; promoSpendCapBps: number } | null {
  if (!wallet) return null;
  return {
    promoAvailablePaise: parseMoney(wallet.promoAvailablePaise),
    cashAvailablePaise: parseMoney(wallet.cashAvailablePaise),
    promoSpendCapBps: wallet.promoSpendCapBps,
  };
}
export interface QuoteRequest {
  userId: string;
  addressId: string;
  tipPaise?: string;
  couponCode?: string | null;
  wallet?: WalletBalanceInput;
}
/** Coupon param overrides the stored coupon for the quote; null drops it for this quote. */
export async function resolveCoupon(
  coupons: Pick<CouponValidation, 'validate'>,
  evaluation: EvaluatedCart,
  userId: string,
  code: string | null,
  tx?: TransactionContext,
): Promise<{ coupon: CouponPublic | null; issue: QuoteIssue | null }> {
  if (!code) return { coupon: null, issue: null };
  try {
    const result = await coupons.validate({
      userId,
      code,
      storeId: evaluation.cart.store_id,
      lines: evaluation.lines
        .filter((line) => line.saleable)
        .map((line) => ({
          variantId: line.variantId,
          productId: line.productId,
          categoryId: line.categoryId,
          quantity: line.quantity,
          unitPricePaise: line.freshUnitPricePaise!,
        })),
      subtotalPaise: evaluation.subtotalPaise,
      tx,
    });
    return { coupon: result.coupon, issue: null };
  } catch (error: unknown) {
    return {
      coupon: null,
      issue: {
        code: 'COUPON_INVALID',
        detail: error instanceof Error ? error.message : 'coupon cannot be applied',
      },
    };
  }
}
/**
 * Rebinds the cart if the address moved, evaluates fresh prices/config and
 * computes the quote. The caller decides whether to persist a snapshot.
 */
export async function buildQuote(
  config: AppConfig,
  coupons: Pick<CouponValidation, 'validate'>,
  tx: TransactionContext,
  request: QuoteRequest,
): Promise<{ evaluation: EvaluatedCart; preview: QuotePreview; coupon: CouponPublic | null }> {
  await advisoryLockCart(tx, request.userId);
  await sql`SELECT pg_advisory_xact_lock_shared(701001)`.execute(tx);
  const cart = await getOrCreateCartRow(tx, request.userId, request.addressId);
  const evaluation = await evaluateCart(tx, config, cart);
  const entitlement = await sql<{
    id: string;
  }>`SELECT id::text FROM referral_claims WHERE friend_id=${request.userId}::uuid AND redeemed_order_id IS NULL`.execute(
    tx,
  );
  const referralClaimId = entitlement.rows[0]?.id ?? null;
  const requested = request.couponCode === undefined ? cart.coupon_code : request.couponCode;
  const { coupon, issue } = await resolveCoupon(coupons, evaluation, request.userId, requested, tx);
  const totals = computeCartQuote(
    evaluation,
    coupon,
    parseTip(request.tipPaise),
    parseWallet(request.wallet),
    referralClaimId !== null,
  );
  return {
    evaluation,
    preview: toPreview(evaluation, totals, coupon, issue, referralClaimId),
    coupon,
  };
}
