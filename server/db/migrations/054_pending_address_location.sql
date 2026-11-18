-- Up Migration
-- A written address can be saved before the customer confirms its location.
-- A null point is never a delivery location and must not be used for checkout.
ALTER TABLE addresses ALTER COLUMN point DROP NOT NULL;

-- Down Migration
-- Do not invent coordinates for addresses awaiting customer confirmation.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM addresses WHERE point IS NULL) THEN
    RAISE EXCEPTION 'Resolve or remove addresses without a location before rollback';
  END IF;
END $$;
ALTER TABLE addresses ALTER COLUMN point SET NOT NULL;
