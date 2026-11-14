// Concurrent creation avoids blocking checkout writes. An interrupted build
// must be repaired explicitly instead of being hidden by IF NOT EXISTS.
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname='orders_checkout_operation_idx' AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid orders_checkout_operation_idx before retrying migration 038'; END IF;
  END $$`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_checkout_operation_idx
    ON orders ((metadata->>'checkoutOperationId'),placed_at)
    WHERE (metadata->>'checkoutOperationId') IS NOT NULL`);
}

export const down = false;
