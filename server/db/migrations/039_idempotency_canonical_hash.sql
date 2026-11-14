-- Up Migration
-- New servers keep the legacy hash for mixed-version deployments and store a
-- canonical hash alongside it. Existing operation references remain intact.
ALTER TABLE idempotency_keys ADD COLUMN canonical_request_hash text;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 039 is forward-only'; END $$;
