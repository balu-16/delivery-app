-- Store-manager portal sessions. Independent from admin_sessions: separate
-- table, key ring, cookie and CSRF header so revoking one portal never
-- touches the other. Forward-only in production; down is development/test only.
-- Up Migration

CREATE TABLE store_sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('cognito','local')),
  tokens bytea NOT NULL,
  csrf_token_hash text NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  rotated_from text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
-- tokens: AES-256-GCM sealed JSON (keyVersion byte || 12-byte IV || 16-byte tag || ciphertext).
CREATE INDEX store_sessions_user_idx ON store_sessions(user_id);
CREATE INDEX store_sessions_active_idle_idx ON store_sessions(idle_expires_at) WHERE revoked_at IS NULL;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 047 is forward-only'; END $$;
