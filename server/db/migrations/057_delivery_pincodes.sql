-- PIN coverage is authoritative for new orders. Existing order snapshots and
-- polygon zones remain intact for historical orders.
-- Up Migration
CREATE TABLE delivery_pincodes (
  id uuid PRIMARY KEY,
  pincode text NOT NULL UNIQUE CHECK (pincode ~ '^[0-9]{6}$'),
  store_id uuid NOT NULL REFERENCES stores(id),
  locality text NOT NULL DEFAULT '' CHECK (length(locality) <= 120),
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX delivery_pincodes_store_idx ON delivery_pincodes(store_id, pincode);
-- Down Migration
DROP TABLE delivery_pincodes;
