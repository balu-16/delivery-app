import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type {
  InventoryAvailability,
  InventoryAvailabilityQuery,
} from '../contracts/availability.js';
export class PostgresInventoryAvailability implements InventoryAvailabilityQuery {
  constructor(private readonly db: Database) {}
  async get(storeId: string, variantId: string): Promise<InventoryAvailability | null> {
    const result =
      await sql<InventoryAvailability>`SELECT i.store_id AS "storeId", i.variant_id AS "variantId", i.on_hand::text AS "onHand", i.reserved::text AS "reserved", a.available::text, i.version::text FROM store_inventory i JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id WHERE i.store_id=${storeId}::uuid AND i.variant_id=${variantId}::uuid`.execute(
        this.db,
      );
    return result.rows[0] ?? null;
  }
}
