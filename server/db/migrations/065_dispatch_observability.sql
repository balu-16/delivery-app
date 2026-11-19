-- Up Migration
-- Dispatch observability (plan4): when a task was released to the pool and
-- how long it has waited without an eligible rider. Operators derive
-- release-to-offer (first rider_offers.sent_at minus released_at),
-- offer-to-accept (responded_at minus sent_at) and open no-rider waits from
-- these columns plus rider_offers; all are additive and nullable/zeroed.
ALTER TABLE delivery_tasks ADD COLUMN released_at timestamptz NULL;
ALTER TABLE delivery_tasks ADD COLUMN no_rider_since timestamptz NULL;
ALTER TABLE delivery_tasks ADD COLUMN no_rider_seconds bigint NOT NULL DEFAULT 0;

-- Down Migration
ALTER TABLE delivery_tasks DROP COLUMN no_rider_seconds;
ALTER TABLE delivery_tasks DROP COLUMN no_rider_since;
ALTER TABLE delivery_tasks DROP COLUMN released_at;
