-- Up Migration
CREATE TABLE customer_favorites (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL REFERENCES catalog_products(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id, product_id)
);
CREATE INDEX customer_favorites_active_idx ON customer_favorites(user_id, product_id) WHERE active;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 034 is forward-only'; END $$;
