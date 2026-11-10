import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { CartRow } from './cart-evaluation.js';
import { resolveStoreForAddress } from './cart-evaluation.js';

type DB = Database | TransactionContext;

export const cartColumns = sql`id::text AS id,user_id::text AS user_id,store_id::text AS store_id,address_id::text AS address_id,coupon_code,version::text AS version`;
export async function advisoryLockCart(tx: TransactionContext, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cart-user:${userId}`},0))`.execute(tx);
}
export async function loadCart(db: DB, userId: string): Promise<CartRow | null> {
  const result =
    await sql<CartRow>`SELECT ${cartColumns} FROM carts WHERE user_id=${userId}::uuid`.execute(db);
  return result.rows[0] ?? null;
}
export async function lockCart(tx: TransactionContext, userId: string): Promise<CartRow> {
  const result =
    await sql<CartRow>`SELECT ${cartColumns} FROM carts WHERE user_id=${userId}::uuid FOR UPDATE`.execute(
      tx,
    );
  const row = result.rows[0];
  if (!row) throw new Error('CART_NOT_FOUND');
  return row;
}
interface PriceRow {
  selling_paise: string;
  mrp_paise: string;
  gst_rate_bps: number | null;
}
/** Add-time price snapshot for a cart line; stored so later reads can flag PRICE_CHANGED. */
export async function currentPrice(
  db: DB,
  storeId: string,
  variantId: string,
): Promise<PriceRow | null> {
  const result =
    await sql<PriceRow>`SELECT p.selling_paise::text AS selling_paise,p.mrp_paise::text AS mrp_paise,prod.gst_rate_bps
    FROM catalog_prices p JOIN catalog_variants v ON v.id=p.variant_id JOIN catalog_products prod ON prod.id=v.product_id
    WHERE p.store_id=${storeId}::uuid AND p.variant_id=${variantId}::uuid
    AND p.valid_from<=statement_timestamp() AND (p.valid_to IS NULL OR p.valid_to>statement_timestamp())
    AND prod.published AND prod.deleted_at IS NULL AND v.deleted_at IS NULL LIMIT 1`.execute(db);
  return result.rows[0] ?? null;
}
/** Saleable units of a variant at a store; the cart never reserves, it only clamps. */
export async function availableAt(db: DB, storeId: string, variantId: string): Promise<bigint> {
  const result = await sql<{ available: string }>`SELECT COALESCE(available,0)::text AS available
    FROM inventory_saleable_availability WHERE store_id=${storeId}::uuid AND variant_id=${variantId}::uuid`.execute(
    db,
  );
  return BigInt(result.rows[0]?.available ?? 0);
}
/**
 * Resolve the single active cart, creating it on first use and rebinding store
 * when the selected address moved stores. Lines are retained and flagged by the
 * next evaluation; the rebind itself bumps the optimistic version.
 */
export async function getOrCreateCartRow(
  tx: TransactionContext,
  userId: string,
  addressId: string,
): Promise<CartRow> {
  const storeId = await resolveStoreForAddress(tx, userId, addressId);
  const existing =
    await sql<CartRow>`SELECT ${cartColumns} FROM carts WHERE user_id=${userId}::uuid FOR UPDATE`.execute(
      tx,
    );
  const row = existing.rows[0];
  if (!row) {
    const created =
      await sql<CartRow>`INSERT INTO carts(id,user_id,address_id,store_id) VALUES(${uuidV7()}::uuid,${userId}::uuid,${addressId}::uuid,${storeId}::uuid)
      RETURNING ${cartColumns}`.execute(tx);
    return created.rows[0]!;
  }
  if (row.store_id === storeId && row.address_id === addressId) return row;
  const updated =
    await sql<CartRow>`UPDATE carts SET store_id=${storeId}::uuid,address_id=${addressId}::uuid,version=version+1,updated_at=clock_timestamp()
    WHERE id=${row.id}::uuid RETURNING ${cartColumns}`.execute(tx);
  return updated.rows[0]!;
}
