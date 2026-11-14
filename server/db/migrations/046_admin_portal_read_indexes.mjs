// P14 admin portal keyset pages: global payment attempts and refunds list by
// newest activity. Concurrent creation avoids blocking commerce writes; an
// interrupted build must be repaired explicitly instead of being hidden.
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname IN ('payment_attempts_recent_idx','payment_refunds_recent_idx') AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid admin portal read indexes before retrying migration 046'; END IF;
  END $$`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_attempts_recent_idx
    ON payment_attempts (created_at DESC, id DESC)`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_refunds_recent_idx
    ON payment_refunds (created_at DESC, id DESC)`);
}

export const down = false;
