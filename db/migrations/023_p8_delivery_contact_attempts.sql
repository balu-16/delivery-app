-- Up Migration
CREATE TABLE delivery_contact_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES delivery_tasks(id),
  rider_id uuid NOT NULL REFERENCES users(id),
  attempt_no integer NOT NULL,
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 150),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id, rider_id, reference)
);
CREATE INDEX delivery_contact_attempts_task_idx ON delivery_contact_attempts(task_id, attempt_no, rider_id, attempted_at);
-- Down Migration
DROP TABLE delivery_contact_attempts;
