-- P14 admin portal sessions. Forward-only in production; down is development/test only.
-- Up Migration
ALTER TABLE local_identity_directory
  ADD COLUMN password_hash text;
-- scrypt$N$r$p$<salt hex>$<hash hex>; NULL keeps the account password-less
-- until scripts/set-local-admin-password.mjs provisions it (local dev only).

CREATE TABLE admin_sessions (
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
-- tokens: AES-256-GCMsealed JSON (keyVersion byte || 12-byte IV || 16-byte tag || ciphertext).
CREATE INDEX admin_sessions_user_idx ON admin_sessions(user_id);
CREATE INDEX admin_sessions_active_idle_idx ON admin_sessions(idle_expires_at) WHERE revoked_at IS NULL;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 045 is forward-only'; END $$;
