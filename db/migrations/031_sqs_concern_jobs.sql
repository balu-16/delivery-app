-- Up Migration
-- New tables only: no existing application rows are changed.
CREATE TABLE sqs_concern_jobs (
  concern text NOT NULL CHECK (concern IN ('outbox','notifications','dispatch','payments','subscriptions','imports','maintenance')),
  id text NOT NULL CHECK (id ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  payload jsonb NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  send_token uuid,
  send_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_send_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failed_at timestamptz,
  PRIMARY KEY (concern,id),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK ((send_token IS NULL) = (send_until IS NULL)),
  CHECK ((state = 'RUNNING') = (lease_token IS NOT NULL)),
  CHECK ((state = 'FAILED') = (failed_at IS NOT NULL))
);
CREATE INDEX sqs_concern_jobs_due_idx ON sqs_concern_jobs (next_send_at,concern,id)
  WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX sqs_concern_jobs_failed_idx ON sqs_concern_jobs (concern,failed_at DESC,id)
  WHERE state = 'FAILED';

CREATE TABLE sqs_concern_schedules (
  concern text NOT NULL CHECK (concern IN ('outbox','notifications','dispatch','payments','subscriptions','imports','maintenance')),
  scheduler_id text NOT NULL CHECK (scheduler_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  payload jsonb NOT NULL,
  schedule jsonb NOT NULL,
  next_run_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (concern,scheduler_id)
);
CREATE INDEX sqs_concern_schedules_due_idx ON sqs_concern_schedules (next_run_at,concern,scheduler_id);

-- Down Migration
-- A downgrade could discard unsent, failed, or scheduled work.
DO $$ BEGIN RAISE EXCEPTION 'migration 031 is forward-only'; END $$;
