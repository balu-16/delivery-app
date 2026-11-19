// Keep shared-price lookups efficient as the store price history grows.
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname='catalog_prices_global_lookup_idx' AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid global price index before retrying migration 062'; END IF;
  END $$`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_prices_global_lookup_idx
    ON catalog_prices(variant_id,valid_from DESC,created_at DESC,id DESC)
    INCLUDE (selling_paise,mrp_paise,valid_to,created_by)`);
}
export const down = false;
