-- Up Migration
-- Additive schema. Checkpointer-owned tables are installed separately by the
-- explicit agent checkpoint setup command, using migration credentials.
ALTER TABLE consents ADD COLUMN revoked_at timestamptz;
ALTER TABLE addresses ADD COLUMN label text CHECK (label IN ('HOME','WORK','OTHER'));
CREATE TABLE address_creation_operations (
  user_id uuid NOT NULL REFERENCES users(id), reference text NOT NULL,
  request_hash text NOT NULL, address_id uuid NOT NULL REFERENCES addresses(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (user_id, reference)
);

CREATE TABLE agent_threads (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  title text, locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','hi','te')),
  last_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_threads_owner_idx ON agent_threads(user_id, last_message_at DESC, id);
CREATE UNIQUE INDEX agent_threads_one_active_idx ON agent_threads(user_id) WHERE status='active';
CREATE TABLE agent_messages (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system_note')),
  text text NOT NULL, cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_message_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(thread_id, client_message_id)
);
CREATE INDEX agent_messages_history_idx ON agent_messages(thread_id, created_at DESC, id DESC);
CREATE TABLE agent_tool_operations (
  thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
  request_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(thread_id,tool_call_id)
);
CREATE TABLE agent_drafts (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL,
  tool_call_id text NOT NULL,
  payload jsonb NOT NULL, payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','executed','failed','stale','superseded')),
  expires_at timestamptz NOT NULL, idempotency_key text NOT NULL UNIQUE,
  result jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(thread_id, tool_call_id)
);
CREATE INDEX agent_drafts_thread_idx ON agent_drafts(thread_id, user_id, created_at DESC);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id), skill text, model text,
  client_message_id uuid, assistant_message_id uuid REFERENCES agent_messages(id) ON DELETE SET NULL,
  input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  thinking_tokens integer NOT NULL DEFAULT 0,
  tool_calls integer NOT NULL DEFAULT 0, latency_ms integer, outcome text,
  error_code text, estimated_cost text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(thread_id, client_message_id)
);
CREATE INDEX agent_runs_daily_idx ON agent_runs(user_id, created_at);
CREATE TABLE agent_feedback (
  message_id uuid PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id), rating text NOT NULL CHECK (rating IN ('up','down')),
  reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE agent_nudge_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id), enabled boolean NOT NULL DEFAULT false,
  ignored_count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Down Migration
DROP TABLE agent_nudge_preferences;
DROP TABLE agent_feedback;
DROP TABLE agent_runs;
DROP TABLE agent_drafts;
DROP TABLE agent_tool_operations;
DROP TABLE agent_messages;
DROP TABLE agent_threads;
DROP TABLE address_creation_operations;
ALTER TABLE addresses DROP COLUMN label;
ALTER TABLE consents DROP COLUMN revoked_at;
