-- Up Migration
ALTER TABLE pick_tasks ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE rider_status ADD COLUMN on_break boolean NOT NULL DEFAULT false;
ALTER TABLE dispatch_operations ADD COLUMN result jsonb;
-- Down Migration
ALTER TABLE dispatch_operations DROP COLUMN result;
ALTER TABLE rider_status DROP COLUMN on_break;
ALTER TABLE pick_tasks DROP COLUMN last_activity_at;
