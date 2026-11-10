-- Up Migration
ALTER TABLE device_tokens ADD COLUMN identifier_type text NOT NULL DEFAULT 'FCM_TOKEN'
  CHECK (identifier_type IN ('FCM_TOKEN','FID'));

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 032 is forward-only'; END $$;
