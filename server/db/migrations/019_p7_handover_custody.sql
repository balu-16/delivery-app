-- Up Migration
ALTER TABLE handover_records ADD COLUMN rider_id uuid REFERENCES users(id);
ALTER TABLE handover_records ADD COLUMN verifier_format smallint NOT NULL DEFAULT 1 CHECK(verifier_format IN (1,2));
-- Down Migration
ALTER TABLE handover_records DROP COLUMN verifier_format;
ALTER TABLE handover_records DROP COLUMN rider_id;
