import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { CatalogLookup, VariantLookup } from '../contracts/lookup.js';

/** Scan-time barcode resolution used by store fulfillment; publish rules apply. */
export class PostgresCatalogLookup implements CatalogLookup {
  constructor(private readonly db: Database) {}
  async variantByBarcode(storeId: string, barcode: string): Promise<VariantLookup | null> {
    if (!storeId || !barcode || barcode.length > 100) throw new Error('INVALID_INPUT');
    const rows =
      await sql<VariantLookup>`SELECT v.id AS "variantId",v.name FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id JOIN store_inventory i ON i.variant_id=v.id AND i.store_id=${storeId}::uuid WHERE v.barcode=${barcode.trim()} AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.published LIMIT 1`.execute(
        this.db,
      );
    return rows.rows[0] ?? null;
  }
  async variantById(variantId: string): Promise<VariantLookup | null> {
    if (!variantId) throw new Error('INVALID_INPUT');
    const rows =
      await sql<VariantLookup>`SELECT v.id AS "variantId",v.name FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.id=${variantId}::uuid AND v.deleted_at IS NULL AND p.deleted_at IS NULL LIMIT 1`.execute(
        this.db,
      );
    return rows.rows[0] ?? null;
  }
}
