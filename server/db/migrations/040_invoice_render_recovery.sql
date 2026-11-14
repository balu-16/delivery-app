-- Up Migration
-- Nullable scheduling/lease fields avoid rewriting existing invoice rows.
ALTER TABLE invoice_documents ADD COLUMN render_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE invoice_documents ADD COLUMN render_next_attempt_at timestamptz;
ALTER TABLE invoice_documents ADD COLUMN render_suspended_at timestamptz;
ALTER TABLE invoice_documents ADD COLUMN render_lease_token uuid;
ALTER TABLE invoice_documents ADD COLUMN render_lease_until timestamptz;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 040 is forward-only'; END $$;
