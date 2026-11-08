-- Up Migration
-- Existing quotes have no reliable fingerprint and must be refreshed before placement.
ALTER TABLE quote_snapshots ADD COLUMN price_fingerprint text;
ALTER TABLE quote_snapshots ADD CONSTRAINT quote_price_fingerprint_shape CHECK (price_fingerprint IS NULL OR price_fingerprint ~ '^[0-9a-f]{64}$');

-- Down Migration
-- Forward only: reverting would restore global inventory-driven quote invalidation.
DO $$ BEGIN RAISE EXCEPTION 'migration 030 is forward-only'; END $$;
