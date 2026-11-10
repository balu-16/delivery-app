import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { transactionWithRetry } from '../../../platform/database/database.js';
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
import { evaluateCart, resolveStoreForAddress, type CartRow } from './cart-evaluation.js';
import { toCartView } from './cart-views.js';
import {
  advisoryLockCart,
  availableAt,
  cartColumns,
  currentPrice,
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
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async getOrCreateActiveCart(
    userId: string,
    addressId: string,
    outer?: TransactionContext,
  ): Promise<CartView> {
    return this.run(outer, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = await getOrCreateCartRow(tx, userId, addressId);
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
    if (row) {
      const evaluation = await evaluateCart(this.db, this.config, row);
      return { storeId: row.store_id, subtotalPaise: evaluation.subtotalPaise };
    }
    if (!addressId) return null;
    return transactionWithRetry(this.db, async (tx) => {
      const storeId = await resolveStoreForAddress(tx, userId, addressId);
      return { storeId, subtotalPaise: 0n };
    });
  }
  async putItem(
    userId: string,
    variantId: string,
    quantity: string,
    opts: CartMutationOptions,
  ): Promise<CartWriteResult> {
    const parsed = parseQuantity(quantity);
    const [maxPerOrder, maxLines] = await Promise.all([
      this.config.get('catalogMaxPerOrder'),
      this.config.get('maxCartLines'),
    ]);
    return this.run(opts.tx, async (tx) => {
      await advisoryLockCart(tx, userId);
      const cart = await this.lockedCart(tx, userId, opts.addressId);
      requireVersion(BigInt(cart.version), opts.expectedVersion);
      if (parsed === 0n) return this.removeItemLine(tx, cart, variantId);
      // An explicit write confirms current saleability and reprices the line.
      const stock = await availableAt(tx, cart.store_id, variantId);
      const price = await currentPrice(tx, cart.store_id, variantId);
      if (stock <= 0n || !price) throw new Error('INVENTORY_INSUFFICIENT');
      const maxPerOrderClamp = clampToMaxPerOrder(parsed, maxPerOrder);
      const finalQuantity = maxPerOrderClamp.quantity > stock ? stock : maxPerOrderClamp.quantity;
      const clamped = finalQuantity !== parsed;
      const existing =
        await sql`SELECT 1 AS one FROM cart_items WHERE cart_id=${cart.id}::uuid AND variant_id=${variantId}::uuid`.execute(
          tx,
        );
      if (!existing.rows.length) {
        const count = await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM cart_items WHERE cart_id=${cart.id}::uuid`.execute(tx);
        if (Number(count.rows[0]!.n) >= maxLines) throw new Error('INVALID_INPUT');
        await sql`INSERT INTO cart_items(cart_id,variant_id,quantity,unit_price_paise,mrp_paise,tax_rate_bps)
          VALUES(${cart.id}::uuid,${variantId}::uuid,${finalQuantity.toString()}::bigint,${price.selling_paise}::bigint,${price.mrp_paise}::bigint,${price.gst_rate_bps ?? 0})`.execute(
          tx,
        );
      } else {
        await sql`UPDATE cart_items SET quantity=${finalQuantity.toString()}::bigint,unit_price_paise=${price.selling_paise}::bigint,mrp_paise=${price.mrp_paise}::bigint,tax_rate_bps=${price.gst_rate_bps ?? 0},updated_at=clock_timestamp()
          WHERE cart_id=${cart.id}::uuid AND variant_id=${variantId}::uuid`.execute(tx);
      }
      const detail = clamped
        ? `quantity clamped to ${finalQuantity} by ${maxPerOrderClamp.quantity > stock ? 'available stock' : 'the per-order maximum'}`
        : null;
      return this.bumpedView(tx, cart.id, clamped ? clampIssue(variantId, detail!) : null);
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
    if (!addressId) throw new Error('CART_NOT_FOUND');
    return getOrCreateCartRow(tx, userId, addressId);
  }
  private async viewOf(db: Database | TransactionContext, cart: CartRow): Promise<CartView> {
    const evaluation = await evaluateCart(db, this.config, cart);
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
    const evaluation = await evaluateCart(tx, this.config, updated.rows[0]!);
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
