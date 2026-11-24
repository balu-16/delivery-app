-- Up Migration
-- Store listing state, product image revision, and import rejection reason
-- (customize2 §3B; additive only, annotation of applied 069/070 untouched).
-- store_inventory.listed defaults true: every existing row stays listed.
-- catalog_products.image_revision is the optimistic-concurrency counter for
-- the admin image-collection write; registrations append and bump it.
-- catalog_import_jobs.rejection_reason is set only on terminal rejection.
ALTER TABLE store_inventory ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT true;
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS image_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE catalog_import_jobs ADD COLUMN IF NOT EXISTS rejection_reason text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'catalog_import_jobs_rejection_reason_check'
  ) THEN
    ALTER TABLE catalog_import_jobs ADD CONSTRAINT catalog_import_jobs_rejection_reason_check
      CHECK (rejection_reason IS NULL OR (length(trim(rejection_reason)) > 0 AND length(rejection_reason) <= 300));
  END IF;
END $$;

-- Down Migration
ALTER TABLE catalog_import_jobs DROP COLUMN IF EXISTS rejection_reason;
ALTER TABLE catalog_products DROP COLUMN IF EXISTS image_revision;
ALTER TABLE store_inventory DROP COLUMN IF EXISTS listed;
