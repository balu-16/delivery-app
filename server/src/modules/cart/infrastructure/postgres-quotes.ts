import { sql } from 'kysely';
import { isDeepStrictEqual } from 'node:util';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CouponValidation } from '../../coupons/contracts/coupons.js';
import type { CartPreviews, CartQuotes, QuotePreview, QuoteSnapshot } from '../contracts/quote.js';
import type { QuoteIssue } from '../contracts/quote.js';
import { buildQuote } from './quote-core.js';
import { advisoryLockCart, lockCart } from './cart-store.js';

interface SnapshotRow {
  id: string;
  cart_id: string;
  cart_version: string;
  user_id: string;
  store_id: string;
  address_id: string;
  referral_claim_id: string | null;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED';
  lines: QuoteSnapshot['lines'];
  fees: QuoteSnapshot['fees'];
  wallet: { promoPaise: string; cashPaise: string } | null;
  coupon_code: string | null;
  coupon_discount_paise: string;
  subtotal_paise: string;
  discount_paise: string;
  fee_total_paise: string;
  tax_total_paise: string;
  tip_paise: string;
  total_paise: string;
  amount_due_paise: string;
  price_version: string;
  price_fingerprint: string | null;
  config_version: string;
  coupon_fingerprint: string | null;
  expires_at: Date;
  created_at: Date;
  issues: QuoteIssue[];
}
const snapshotColumns = sql`id::text AS id,cart_id::text AS cart_id,cart_version::text AS cart_version,user_id::text AS user_id,
  store_id::text AS store_id,address_id::text AS address_id,referral_claim_id::text AS referral_claim_id,status,lines,fees,wallet,coupon_code,
  coupon_discount_paise::text AS coupon_discount_paise,subtotal_paise::text AS subtotal_paise,discount_paise::text AS discount_paise,
  fee_total_paise::text AS fee_total_paise,tax_total_paise::text AS tax_total_paise,tip_paise::text AS tip_paise,
  total_paise::text AS total_paise,amount_due_paise::text AS amount_due_paise,price_version::text AS price_version,
  config_version::text AS config_version,price_fingerprint,coupon_fingerprint,expires_at,created_at,issues`;
function toSnapshot(row: SnapshotRow): QuoteSnapshot {
  return {
    quoteId: row.id,
    cartId: row.cart_id,
    cartVersion: Number(row.cart_version),
    userId: row.user_id,
    storeId: row.store_id,
    addressId: row.address_id,
    referralClaimId: row.referral_claim_id,
    status: row.status,
    lines: row.lines,
    fees: row.fees,
    wallet: row.wallet,
    couponCode: row.coupon_code,
    couponDiscountPaise: row.coupon_discount_paise,
    subtotalPaise: row.subtotal_paise,
    discountPaise: row.discount_paise,
    feeTotalPaise: row.fee_total_paise,
    taxTotalPaise: row.tax_total_paise,
    tipPaise: row.tip_paise,
    totalPaise: row.total_paise,
    amountDuePaise: row.amount_due_paise,
    priceVersion: row.price_version,
    configVersion: row.config_version,
    couponFingerprint: row.coupon_fingerprint,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    issues: row.issues,
  };
}
export class PostgresQuotes implements CartQuotes {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly coupons: CouponValidation,
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async refresh(input: Parameters<CartQuotes['refresh']>[0]): Promise<QuoteSnapshot> {
    return this.run(input.tx, async (tx) => {
      const { evaluation, preview } = await buildQuote(this.config, this.coupons, tx, input);
      const windowSeconds = await this.config.get('paymentWindowSeconds', tx);
      const now = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
      const expiresAt = new Date(new Date(now.rows[0]!.now).getTime() + windowSeconds * 1000);
      await sql`UPDATE quote_snapshots SET status='SUPERSEDED' WHERE cart_id=${evaluation.cart.id}::uuid AND status='ACTIVE'`.execute(
        tx,
      );
      const quoteId = uuidV7();
      await sql`INSERT INTO quote_snapshots(id,cart_id,cart_version,user_id,store_id,address_id,status,lines,fees,issues,wallet,
        coupon_code,coupon_discount_paise,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,
        amount_due_paise,price_version,price_fingerprint,config_version,coupon_fingerprint,expires_at,referral_claim_id)
        VALUES(${quoteId}::uuid,${evaluation.cart.id}::uuid,${evaluation.cart.version}::bigint,${evaluation.cart.user_id}::uuid,
        ${evaluation.cart.store_id}::uuid,${evaluation.cart.address_id}::uuid,'ACTIVE',
        ${JSON.stringify(preview.lines)}::jsonb,${JSON.stringify(preview.fees)}::jsonb,${JSON.stringify(preview.issues)}::jsonb,
        ${preview.wallet === null ? null : JSON.stringify(preview.wallet)}::jsonb,
        ${preview.couponCode},${preview.couponDiscountPaise}::bigint,${preview.subtotalPaise}::bigint,${preview.discountPaise}::bigint,
        ${preview.feeTotalPaise}::bigint,${preview.taxTotalPaise}::bigint,${preview.tipPaise}::bigint,${preview.totalPaise}::bigint,
        ${preview.amountDuePaise}::bigint,${preview.priceVersion}::bigint,${evaluation.priceFingerprint},${preview.configVersion}::bigint,
        ${preview.couponFingerprint},${expiresAt},${preview.referralClaimId}::uuid)`.execute(tx);
      return {
        ...preview,
        quoteId,
        userId: evaluation.cart.user_id,
        status: 'ACTIVE',
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date(now.rows[0]!.now).toISOString(),
      };
    });
  }
  async get(quoteId: string, userId: string, outer?: TransactionContext): Promise<QuoteSnapshot> {
    return this.run(outer, async (tx) => {
      if (outer) {
        await advisoryLockCart(tx, userId);
        await lockCart(tx, userId);
      }
      const result =
        await sql<SnapshotRow>`SELECT ${snapshotColumns} FROM quote_snapshots WHERE id=${quoteId}::uuid AND user_id=${userId}::uuid FOR UPDATE`.execute(
          tx,
        );
      const row = result.rows[0];
      // Another user's quote must not reveal its existence.
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.status === 'CONSUMED') throw new Error('QUOTE_CONSUMED');
      if (row.status !== 'ACTIVE') throw new Error('QUOTE_EXPIRED');
      const now = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
      if (new Date(row.expires_at) <= new Date(now.rows[0]!.now)) {
        await sql`UPDATE quote_snapshots SET status='EXPIRED' WHERE id=${row.id}::uuid`.execute(tx);
        throw new Error('QUOTE_EXPIRED');
      }
      const snapshot = toSnapshot(row);
      if (outer) await this.revalidate(tx, snapshot, row.price_fingerprint);
      return snapshot;
    });
  }
  private async revalidate(
    tx: TransactionContext,
    quote: QuoteSnapshot,
    fingerprint: string | null,
  ): Promise<void> {
    const cart = await lockCart(tx, quote.userId);
    if (
      cart.id !== quote.cartId ||
      Number(cart.version) !== quote.cartVersion ||
      cart.store_id !== quote.storeId ||
      cart.address_id !== quote.addressId
    )
      throw new Error('CONCURRENT_MODIFICATION');
    const issue = quote.issues.find((value) => value.code !== 'PRICE_CHANGED');
    if (issue) throw new Error(issue.code);
    const ids = quote.lines.map((line) => line.variantId).sort();
    if (ids.length) {
      await sql`SELECT id FROM catalog_variants WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`.execute(
        tx,
      );
      await sql`SELECT p.id FROM catalog_products p WHERE p.id IN (SELECT product_id FROM catalog_variants
        WHERE id=ANY(${ids}::uuid[])) ORDER BY p.id FOR SHARE`.execute(tx);
      await sql`SELECT id FROM catalog_prices WHERE store_id=${quote.storeId}::uuid AND variant_id=ANY(${ids}::uuid[])
        ORDER BY id FOR SHARE`.execute(tx);
    }
    const { preview, evaluation } = await buildQuote(this.config, this.coupons, tx, {
      userId: quote.userId,
      addressId: quote.addressId,
      tipPaise: quote.tipPaise,
      couponCode: quote.couponCode,
    });
    if (!fingerprint || evaluation.priceFingerprint !== fingerprint)
      throw new Error('PRICE_CHANGED');
    const freshIssue = preview.issues.find((value) => value.code !== 'PRICE_CHANGED');
    if (freshIssue)
      throw new Error(
        freshIssue.code === 'ITEM_UNAVAILABLE' || freshIssue.code === 'QTY_REDUCED'
          ? 'INVENTORY_INSUFFICIENT'
          : freshIssue.code,
      );
    if (
      preview.configVersion !== quote.configVersion ||
      preview.couponFingerprint !== quote.couponFingerprint ||
      preview.referralClaimId !== quote.referralClaimId ||
      !isDeepStrictEqual(preview.lines, quote.lines) ||
      !isDeepStrictEqual(preview.fees, quote.fees) ||
      preview.totalPaise !== quote.totalPaise
    )
      throw new Error('PRICE_CHANGED');
  }
  async markConsumed(quoteId: string, tx?: TransactionContext): Promise<void> {
    const consume = async (executor: TransactionContext) => {
      const updated =
        await sql`UPDATE quote_snapshots SET status='CONSUMED',consumed_at=clock_timestamp()
        WHERE id=${quoteId}::uuid AND status='ACTIVE'`.execute(executor);
      if (!updated.numAffectedRows) throw new Error('QUOTE_CONSUMED');
    };
    if (tx) await consume(tx);
    else await transactionWithRetry(this.db, consume);
  }
}
export class PostgresPreviews implements CartPreviews {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly coupons: CouponValidation,
  ) {}
  async preview(input: Parameters<CartPreviews['preview']>[0]): Promise<QuotePreview> {
    const run = input.tx
      ? (fn: (tx: TransactionContext) => Promise<QuotePreview>) => fn(input.tx!)
      : (fn: (tx: TransactionContext) => Promise<QuotePreview>) =>
          transactionWithRetry(this.db, fn);
    return run(async (tx) => {
      const { preview } = await buildQuote(this.config, this.coupons, tx, input);
      return preview;
    });
  }
}
