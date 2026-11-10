-- Up Migration
CREATE TABLE push_campaigns (
 id uuid PRIMARY KEY,
 created_by uuid NOT NULL REFERENCES users(id),
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 target jsonb NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(created_by,idempotency_key)
);
CREATE TABLE push_campaign_targets (
 campaign_id uuid NOT NULL REFERENCES push_campaigns(id),
 notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 token_id uuid NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
 token_updated_at timestamptz NOT NULL,
 PRIMARY KEY(campaign_id,token_id)
);
CREATE INDEX push_campaign_targets_notification_idx ON push_campaign_targets(notification_id);
-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 033 is forward-only'; END $$;
