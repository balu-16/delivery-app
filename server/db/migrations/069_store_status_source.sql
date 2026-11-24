-- Up Migration
-- Store status provenance (customize2 §3A): which control domain put the store
-- into its current status. Existing rows keep NULL, which the application
-- treats as legacy admin-controlled; no backfill is performed on purpose.
ALTER TABLE store_status_history ADD COLUMN source text NULL
  CHECK (source IS NULL OR source IN ('ADMIN', 'MANAGER', 'SYSTEM'));

-- Down Migration
ALTER TABLE store_status_history DROP COLUMN IF EXISTS source;
