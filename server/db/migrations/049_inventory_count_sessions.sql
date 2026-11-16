-- Store-manager portal: persistent multi-line stock-count sessions. A manager
-- opens a session, records counted quantities over multiple visits, and then
-- completes it; completion delegates each line to the existing cycle-count
-- engine so approval thresholds, version checks and the stock ledger stay in
-- one place.
-- Up Migration

CREATE TABLE inventory_count_sessions (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  created_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  CHECK ((status = 'OPEN') = (completed_at IS NULL AND completed_by IS NULL))
);
CREATE INDEX inventory_count_sessions_store_idx ON inventory_count_sessions(store_id, created_at DESC, id DESC);

CREATE TABLE inventory_count_session_lines (
  session_id uuid NOT NULL REFERENCES inventory_count_sessions(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  variant_id uuid NOT NULL REFERENCES catalog_variants(id),
  batch_id uuid NOT NULL REFERENCES inventory_batches(id),
  expected_qty bigint NOT NULL CHECK (expected_qty >= 0),
  counted_qty bigint CHECK (counted_qty >= 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  outcome text CHECK (outcome IN ('APPLIED','PENDING_APPROVAL','FAILED')),
  outcome_detail text CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, line_no),
  UNIQUE (session_id, batch_id)
);

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 049 is forward-only'; END $$;
