-- Up Migration
CREATE TABLE delivery_wrong_address_flags (
  id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES delivery_tasks(id),
  rider_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id), resolution_reason text,
  CHECK ((resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL) OR
         (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_reason IS NOT NULL AND length(resolution_reason) BETWEEN 1 AND 300))
);
-- Down Migration
DROP TABLE delivery_wrong_address_flags;
