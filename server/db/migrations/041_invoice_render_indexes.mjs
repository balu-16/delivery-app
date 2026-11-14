export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname IN ('invoice_render_due_idx','invoice_render_suspended_idx') AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid invoice render indexes before retrying migration 041'; END IF;
  END $$`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS invoice_render_due_idx
    ON invoice_documents ((COALESCE(render_next_attempt_at,created_at)),created_at,id)
    WHERE renderer_state IN ('PENDING','FAILED') AND render_suspended_at IS NULL`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS invoice_render_suspended_idx
    ON invoice_documents (id DESC) WHERE render_suspended_at IS NOT NULL`);
}

export const down = false;
