-- Store-manager portal: persistent return-inspection drafts. One draft per
-- failed-delivery order; per-item QC decisions survive page refreshes until
-- the manager submits them through the existing return QC endpoint.
-- Up Migration

CREATE TABLE return_inspection_drafts (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  saved_by uuid NOT NULL REFERENCES users(id),
  items jsonb NOT NULL,
  note text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX return_inspection_drafts_store_idx ON return_inspection_drafts(store_id, updated_at DESC);

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 048 is forward-only'; END $$;
