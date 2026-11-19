import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { transactionWithRetry } from '../../../platform/database/database.js';
import type { HttpMetrics } from '../../../platform/metrics/http-metrics.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CouponValidation } from '../../coupons/contracts/coupons.js';
import type {
  CartMutationOptions,
  CartService,
  CartView,
  CartWriteResult,
} from '../contracts/cart.js';
import { clampToMaxPerOrder, parseQuantity, requireVersion } from '../domain/cart.js';
import { normalizeCode } from '../../coupons/contracts/coupons.js';
import {
  evaluateCart,
  evaluateCartLines,
  resolveStoreForAddress,
  type CartRow,
} from './cart-evaluation.js';
import { toCartView } from './cart-views.js';
import {
  advisoryLockCart,
  availableAt,
  cartColumns,
  getOrCreateCartRow,
  loadCart,
  lockCart,
} from './cart-store.js';

type ExtraIssue = { code: 'QTY_REDUCED'; variantId: string; detail: string };
function clampIssue(variantId: string, detail: string): ExtraIssue {
  return { code: 'QTY_REDUCED', variantId, detail };
}
export class PostgresCartService implements CartService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly coupons: CouponValidation,
    private readonly metrics?: HttpMetrics,
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async getOrCreateActiveCart(
    userId: string,
    addressId: string | undefined,
    outer?: TransactionContext,
  ): Promise<CartView> {
    return this.run(outer, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = addressId
        ? await getOrCreateCartRow(tx, userId, addressId)
        : await this.lockedCart(tx, userId);
      return this.viewOf(tx, cart);
    });
  }
  /** Read-only view with freshly computed issues; never mutates the cart. */
  async get(userId: string, tx?: TransactionContext): Promise<CartView | null> {
    const executor = tx ?? this.db;
    const row = await loadCart(executor, userId);
    if (!row) return null;
    return this.viewOf(executor, row);
  }
  async freshSubtotal(
    userId: string,
    addressId?: string,
  ): Promise<{ storeId: string; subtotalPaise: bigint } | null> {
    const row = await loadCart(this.db, userId);
    if (row?.store_id && (!addressId || row.address_id === addressId)) {
      const evaluation = await evaluateCart(this.db, this.config, row);
      return { storeId: row.store_id, subtotalPaise: evaluation.subtotalPaise };
    }
    if (!addressId) return null;
    return transactionWithRetry(this.db, async (tx) => {
      const storeId = await resolveStoreForAddress(tx, userId, addressId);
      const evaluation = row
        ? await evaluateCart(tx, this.config, { ...row, store_id: storeId, address_id: addressId })
        : null;
      return { storeId, subtotalPaise: evaluation?.subtotalPaise ?? 0n };
    });
  }
  async putItem(
    userId: string,
    variantId: string,
    quantity: string,
    opts: CartMutationOptions,
  ): Promise<CartWriteResult> {
    const parsed = parseQuantity(quantity);
    return this.run(opts.tx, async (tx) => {
      // Use the same transaction as the idempotent write. Fetching config from
      // the pool here can deadlock when that transaction owns the last client.
      const { catalogMaxPerOrder: maxPerOrder, maxCartLines: maxLines } = this.config.getMany
        ? await this.config.getMany(['catalogMaxPerOrder', 'maxCartLines'], tx)
        : {
            catalogMaxPerOrder: await this.config.get('catalogMaxPerOrder', tx),
            maxCartLines: await this.config.get('maxCartLines', tx),
          };
      const lockStarted = performance.now();
      await advisoryLockCart(tx, userId);
      const cart = await this.lockedCart(tx, userId, opts.addressId);
      this.metrics?.observeStage('cart_lock_wait', performance.now() - lockStarted);
      requireVersion(BigInt(cart.version), opts.expectedVersion);
      if (parsed === 0n) return this.removeItemLine(tx, cart, variantId);
      // One read under the cart lock: current price, target line and line count.
      const combined = await sql<{
        selling_paise: string;
        mrp_paise: string;
        gst_rate_bps: number | null;
        existing_quantity: string | null;
        existing_unit_price: string | null;
        line_count: string;
      }>`SELECT p.selling_paise::text AS selling_paise,p.mrp_paise::text AS mrp_paise,prod.gst_rate_bps,
        ci.quantity::text AS existing_quantity,ci.unit_price_paise::text AS existing_unit_price,
        (SELECT count(*)::text FROM cart_items WHERE cart_id=${cart.id}::uuid) AS line_count
        FROM catalog_global_prices p JOIN catalog_variants v ON v.id=p.variant_id JOIN catalog_products prod ON prod.id=v.product_id
        LEFT JOIN cart_items ci ON ci.cart_id=${cart.id}::uuid AND ci.variant_id=${variantId}::uuid
        WHERE p.variant_id=${variantId}::uuid AND prod.published AND prod.deleted_at IS NULL AND v.deleted_at IS NULL LIMIT 1`.execute(
        tx,
      );
      // An explicit write confirms current saleability and reprices the line.
      const price = combined.rows[0];
      if (!price) throw new Error('ITEM_UNAVAILABLE');
      if (
        opts.displayedUnitPricePaise !== undefined &&
        opts.displayedUnitPricePaise !== price.selling_paise
      )
        throw new Error('PRICE_CHANGED');
      const maxPerOrderClamp = clampToMaxPerOrder(parsed, maxPerOrder);
      const finalQuantity = maxPerOrderClamp.quantity;
      const clamped = finalQuantity !== parsed;
      if (opts.requireAvailableQuantity) {
        if (clamped) throw new Error('INVALID_QUANTITY');
        if (cart.store_id && (await availableAt(tx, cart.store_id, variantId)) < parsed)
          throw new Error('INVENTORY_INSUFFICIENT');
      }
      const hasLine = price.existing_quantity !== null;
      if (
        hasLine &&
        opts.displayedUnitPricePaise !== undefined &&
        !opts.acceptPriceChange &&
        price.existing_unit_price !== opts.displayedUnitPricePaise
      )
        throw new Error('PRICE_CHANGED');
      if (!hasLine && Number(price.line_count) >= maxLines) throw new Error('INVALID_INPUT');
      // Earlier app versions confirm a changed price by writing the same quantity
      // with their address; ordinary quantity changes must keep the stored price.
      const accepted =
        opts.acceptPriceChange === true ||
        (opts.acceptPriceChange === undefined &&
          opts.addressId !== undefined &&
          price.existing_quantity === parsed.toString());
      // The line change and cart version bump apply in one statement; the
      // returned row feeds the existing cart-view evaluation unchanged.
      const bumped = hasLine
        ? await sql<CartRow>`WITH updated_line AS (
            UPDATE cart_items SET quantity=${finalQuantity.toString()}::bigint,
            unit_price_paise=CASE WHEN ${accepted} THEN ${price.selling_paise}::bigint ELSE unit_price_paise END,
            mrp_paise=CASE WHEN ${accepted} THEN ${price.mrp_paise}::bigint ELSE mrp_paise END,
            tax_rate_bps=CASE WHEN ${accepted} THEN ${price.gst_rate_bps ?? 0} ELSE tax_rate_bps END,updated_at=clock_timestamp()
            WHERE cart_id=${cart.id}::uuid AND variant_id=${variantId}::uuid RETURNING 1)
          UPDATE carts SET version=version+1,updated_at=clock_timestamp() WHERE id=${cart.id}::uuid RETURNING ${cartColumns}`.execute(
            tx,
          )
        : await sql<CartRow>`WITH inserted_line AS (
            INSERT INTO cart_items(cart_id,variant_id,quantity,unit_price_paise,mrp_paise,tax_rate_bps)
            VALUES(${cart.id}::uuid,${variantId}::uuid,${finalQuantity.toString()}::bigint,${price.selling_paise}::bigint,${price.mrp_paise}::bigint,${price.gst_rate_bps ?? 0})
            RETURNING 1)
          UPDATE carts SET version=version+1,updated_at=clock_timestamp() WHERE id=${cart.id}::uuid RETURNING ${cartColumns}`.execute(
            tx,
          );
      const updated = bumped.rows[0];
      if (!updated) throw new Error('CART_NOT_FOUND');
      const detail = clamped
        ? `quantity clamped to ${finalQuantity} by the per-order maximum`
        : null;
      const extraIssue = clamped ? clampIssue(variantId, detail!) : null;
      const evaluation = await evaluateCartLines(tx, updated);
      const issues = extraIssue ? [...evaluation.issues, extraIssue] : evaluation.issues;
      return { cart: toCartView(updated, evaluation.lines, issues), clamped: extraIssue !== null };
    });
  }
  async deleteItem(
    userId: string,
    variantId: string,
    opts: CartMutationOptions,
  ): Promise<CartView> {
    return this.run(opts.tx, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = await lockCart(tx, userId);
      requireVersion(BigInt(cart.version), opts.expectedVersion);
      await sql`DELETE FROM cart_items WHERE cart_id=${cart.id}::uuid AND variant_id=${variantId}::uuid`.execute(
        tx,
      );
      return (await this.bumpedView(tx, cart.id, null)).cart;
    });
  }
  async deleteCart(userId: string, opts: CartMutationOptions): Promise<void> {
    return this.run(opts.tx, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = await lockCart(tx, userId);
      requireVersion(BigInt(cart.version), opts.expectedVersion);
      await sql`DELETE FROM carts WHERE id=${cart.id}::uuid`.execute(tx);
    });
  }
  async applyCoupon(userId: string, code: string, opts: CartMutationOptions): Promise<CartView> {
    const normalized = normalizeCode(code);
    return this.run(opts.tx, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = await lockCart(tx, userId);
      requireVersion(BigInt(cart.version), opts.expectedVersion);
      if (!cart.store_id) throw new Error('ADDRESS_REQUIRED');
      const evaluation = await evaluateCart(tx, this.config, cart);
      if (cart.coupon_code !== null && cart.coupon_code !== normalized) {
        // A non-stackable coupon cannot stack on an already-applied coupon.
        const candidate = await sql<{
          stackable: boolean;
        }>`SELECT stackable FROM coupons WHERE code=${normalized}`.execute(tx);
        if (candidate.rows.length && !candidate.rows[0]!.stackable)
          throw new Error('COUPON_NOT_ELIGIBLE');
      }
      // Full coupon rules run on every application; failures keep their codes.
      await this.coupons.validate({
        userId,
        code: normalized,
        storeId: cart.store_id,
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
      const updated =
        await sql<CartRow>`UPDATE carts SET coupon_code=${normalized},version=version+1,updated_at=clock_timestamp() WHERE id=${cart.id}::uuid RETURNING ${cartColumns}`.execute(
          tx,
        );
      return this.viewOf(tx, updated.rows[0]!);
    });
  }
  async removeCoupon(userId: string, opts: CartMutationOptions): Promise<CartView> {
    return this.run(opts.tx, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = await lockCart(tx, userId);
      requireVersion(BigInt(cart.version), opts.expectedVersion);
      const updated =
        await sql<CartRow>`UPDATE carts SET coupon_code=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=${cart.id}::uuid RETURNING ${cartColumns}`.execute(
          tx,
        );
      return this.viewOf(tx, updated.rows[0]!);
    });
  }
  /** Locks the active cart, creating the first one at the given address when absent. */
  private async lockedCart(tx: TransactionContext, userId: string, addressId?: string) {
    const existing =
      await sql<CartRow>`SELECT ${cartColumns} FROM carts WHERE user_id=${userId}::uuid FOR UPDATE`.execute(
        tx,
      );
    if (existing.rows[0]) return existing.rows[0];
    if (addressId) return getOrCreateCartRow(tx, userId, addressId);
    const created =
      await sql<CartRow>`INSERT INTO carts(id,user_id) VALUES(${uuidV7()}::uuid,${userId}::uuid) RETURNING ${cartColumns}`.execute(
        tx,
      );
    return created.rows[0]!;
  }
  private async viewOf(db: Database | TransactionContext, cart: CartRow): Promise<CartView> {
    const evaluation = await evaluateCartLines(db, cart);
    return toCartView(cart, evaluation.lines, evaluation.issues);
  }
  private async bumpedView(
    tx: TransactionContext,
    cartId: string,
    extraIssue: ExtraIssue | null,
  ): Promise<CartWriteResult> {
    const updated =
      await sql<CartRow>`UPDATE carts SET version=version+1,updated_at=clock_timestamp() WHERE id=${cartId}::uuid RETURNING ${cartColumns}`.execute(
        tx,
      );
    const evaluation = await evaluateCartLines(tx, updated.rows[0]!);
    const issues = extraIssue ? [...evaluation.issues, extraIssue] : evaluation.issues;
    return {
      cart: toCartView(updated.rows[0]!, evaluation.lines, issues),
      clamped: extraIssue !== null,
    };
  }
  private async removeItemLine(
    tx: TransactionContext,
    cart: CartRow,
    variantId: string,
  ): Promise<CartWriteResult> {
    const removed =
      await sql`DELETE FROM cart_items WHERE cart_id=${cart.id}::uuid AND variant_id=${variantId}::uuid`.execute(
        tx,
      );
    if (removed.numAffectedRows) return this.bumpedView(tx, cart.id, null);
    return { cart: await this.viewOf(tx, cart), clamped: false };
  }
}
