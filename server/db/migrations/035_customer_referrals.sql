-- Up Migration
CREATE TABLE referral_codes (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-F0-9]{16}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE referral_claims (
  id uuid PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES users(id),
  friend_id uuid NOT NULL UNIQUE REFERENCES users(id),
  code text NOT NULL CHECK (code ~ '^[A-F0-9]{16}$'),
  credit_expires_at timestamptz NOT NULL,
  redeemed_order_id uuid UNIQUE REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (friend_id <> referrer_id)
);
CREATE INDEX referral_claims_referrer_idx ON referral_claims(referrer_id, id);
ALTER TABLE quote_snapshots ADD COLUMN referral_claim_id uuid REFERENCES referral_claims(id);

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 035 is forward-only'; END $$;
