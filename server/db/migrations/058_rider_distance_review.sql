-- Unknown distance is distinct from a zero-distance delivery. Base earnings
-- remain payable and a reviewed distance is a separate payout obligation.
-- Up Migration
ALTER TABLE rider_earnings ALTER COLUMN distance_metres DROP NOT NULL;
ALTER TABLE rider_earnings ADD COLUMN distance_rate_paise bigint CHECK (distance_rate_paise IS NULL OR distance_rate_paise >= 0);
CREATE TABLE rider_distance_adjustments (
  id uuid PRIMARY KEY,
  earning_id uuid NOT NULL UNIQUE REFERENCES rider_earnings(id),
  rider_id uuid NOT NULL REFERENCES users(id),
  distance_metres integer NOT NULL CHECK (distance_metres >= 0),
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
  actor_id uuid NOT NULL REFERENCES users(id),
  payout_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rider_distance_adjustments_pending_idx ON rider_distance_adjustments(rider_id, created_at) WHERE payout_reference IS NULL;
CREATE TABLE payout_distance_claims (
  payout_id uuid NOT NULL REFERENCES rider_payouts(id),
  adjustment_id uuid NOT NULL REFERENCES rider_distance_adjustments(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(payout_id, adjustment_id)
);
CREATE UNIQUE INDEX one_active_claim_per_distance_adjustment ON payout_distance_claims(adjustment_id) WHERE active;
-- Down Migration
DROP TABLE payout_distance_claims;
DROP TABLE rider_distance_adjustments;
ALTER TABLE rider_earnings DROP COLUMN distance_rate_paise;
-- Down cannot safely restore NOT NULL after location-free deliveries exist.
