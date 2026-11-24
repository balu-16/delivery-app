-- Up Migration
-- Tracked referral invitations (plan3 §6). Each Share invite confirmation
-- creates one single-use code; the permanent 16-hex code keeps working.
CREATE TABLE referral_invites (
  id uuid PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^INV-[A-F0-9]{32}$'),
  label text NULL CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 48)),
  claim_id uuid NULL UNIQUE REFERENCES referral_claims(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX referral_invites_referrer_idx ON referral_invites(referrer_id, created_at DESC, id DESC);

-- Down Migration
DROP INDEX IF EXISTS referral_invites_referrer_idx;
DROP TABLE IF EXISTS referral_invites;
