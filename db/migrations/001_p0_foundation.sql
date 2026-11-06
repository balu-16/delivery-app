-- P0 foundation; owner: platform. Initial empty tables, so indexes are transactional.
-- Production corrections are forward migrations; DOWN is for development/test only.
-- Up Migration
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE durable_operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  reference text NOT NULL,
  state text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, reference)
);

CREATE TABLE idempotency_keys (
  actor text NOT NULL,
  audience text NOT NULL,
  method text NOT NULL,
  resource text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  operation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('PROCESSING', 'COMPLETED')),
  owner_token uuid,
  lease_until timestamptz,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  response_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor, audience, method, resource, key),
  CHECK ((state = 'PROCESSING' AND owner_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state = 'COMPLETED' AND owner_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX idempotency_response_expiry_idx ON idempotency_keys (response_expires_at)
  WHERE response_body IS NOT NULL;

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id text NOT NULL,
  causation_id text,
  payload jsonb NOT NULL,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)
);
CREATE TABLE outbox_deliveries (
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  consumer text NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  next_publish_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  suspended_at timestamptz,
  last_enqueued_at timestamptz,
  completed_at timestamptz,
  last_error text,
  PRIMARY KEY (event_id, consumer),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX outbox_delivery_due_idx ON outbox_deliveries (next_publish_at, event_id, consumer)
  WHERE completed_at IS NULL AND suspended_at IS NULL;
CREATE TABLE processed_events (
  consumer text NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, event_id)
);

-- Down Migration
DROP TABLE processed_events;
DROP TABLE outbox_deliveries;
DROP TABLE outbox_events;
DROP TABLE idempotency_keys;
DROP TABLE durable_operations;
-- Shared extensions are deliberately retained.
