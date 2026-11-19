-- Up Migration
-- A cart can exist before a customer has chosen where it will be delivered.
ALTER TABLE carts ALTER COLUMN address_id DROP NOT NULL;
ALTER TABLE carts ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE carts ADD CONSTRAINT carts_address_store_pair
  CHECK ((address_id IS NULL) = (store_id IS NULL)) NOT VALID;
ALTER TABLE carts VALIDATE CONSTRAINT carts_address_store_pair;

-- The most recently effective price is the shared selling price for a variant.
-- Existing store price history remains intact and future scheduled prices work.
CREATE VIEW catalog_global_prices AS
SELECT DISTINCT ON (variant_id) id, variant_id, selling_paise, mrp_paise,
  valid_from, valid_to, created_by, created_at
FROM catalog_prices
WHERE valid_from <= statement_timestamp()
  AND (valid_to IS NULL OR valid_to > statement_timestamp())
ORDER BY variant_id, valid_from DESC, created_at DESC, id DESC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='delivery_runtime') THEN
    GRANT SELECT ON catalog_global_prices TO delivery_runtime;
  END IF;
END $$;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Address-free carts require a forward migration'; END $$;
