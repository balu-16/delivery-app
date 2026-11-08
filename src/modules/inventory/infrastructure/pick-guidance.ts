import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { FefoBatch, InventoryPickGuidance } from '../contracts/pick-guidance.js';

/**
 * With `orderId`: the order's own allocated batches per variant, FEFO
 * ordered — the batches the picker must scan. Without it: earliest-expiry
 * eligible surplus batches per variant (state, on-hand surplus and category
 * shelf life at the target delivery time). Expired, quarantined and damaged
 * batches are never suggested.
 */
export class PostgresPickGuidance implements InventoryPickGuidance {
  constructor(private readonly db: Database) {}
  async suggest(input: {
    storeId: string;
    variantIds: string[];
    targetDeliveryAt: string;
    orderId?: string;
    limit?: number;
  }): Promise<Map<string, FefoBatch[]>> {
    const limit = input.limit ?? 3;
    if (
      !input.storeId ||
      !input.variantIds.length ||
      input.variantIds.length > 200 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      input.variantIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))
    )
      throw new Error('INVALID_INPUT');
    const target = new Date(input.targetDeliveryAt);
    if (!Number.isFinite(target.getTime())) throw new Error('INVALID_TARGET_TIME');
    const rows = input.orderId
      ? await sql<{
          variant_id: string;
          id: string;
          batch_code: string;
          expires_at: Date | null;
          available: string;
        }>`SELECT a.variant_id,b.id,b.batch_code,b.expires_at,a.quantity::text AS available FROM inventory_allocations a JOIN inventory_batches b ON b.id=a.batch_id WHERE a.order_id=${input.orderId}::uuid AND a.store_id=${input.storeId}::uuid AND a.variant_id=ANY(${input.variantIds}::uuid[]) ORDER BY a.variant_id,b.expires_at ASC NULLS LAST,b.id`.execute(
          this.db,
        )
      : await sql<{
          variant_id: string;
          id: string;
          batch_code: string;
          expires_at: Date | null;
          available: string;
        }>`SELECT b.variant_id,b.id,b.batch_code,b.expires_at,(b.on_hand-b.reserved)::text AS available FROM inventory_batches b JOIN catalog_variants v ON v.id=b.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE b.store_id=${input.storeId}::uuid AND b.variant_id=ANY(${input.variantIds}::uuid[]) AND b.state='ACTIVE' AND b.on_hand>b.reserved AND (b.expires_at IS NULL OR b.expires_at>GREATEST(clock_timestamp(),${target.toISOString()}::timestamptz)+COALESCE(s.min_seconds,0)*interval '1 second') ORDER BY b.variant_id,b.expires_at ASC NULLS LAST,b.id`.execute(
          this.db,
        );
    const result = new Map<string, FefoBatch[]>();
    for (const row of rows.rows) {
      const list = result.get(row.variant_id) ?? [];
      if (list.length >= limit) continue;
      list.push({
        batchId: row.id,
        batchCode: row.batch_code,
        expiresAt: row.expires_at?.toISOString() ?? null,
        availableQty: row.available,
      });
      result.set(row.variant_id, list);
    }
    return result;
  }
}
