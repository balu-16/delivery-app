-- Up Migration
ALTER TABLE private_media DROP CONSTRAINT private_media_purpose_check;
ALTER TABLE private_media ADD CONSTRAINT private_media_purpose_check CHECK (
  purpose IN ('RIDER_KYC','DELIVERY_POD','SUPPORT_ATTACHMENT','PAYOUT_EVIDENCE','CUSTOMER_PROFILE_COVER')
) NOT VALID;
ALTER TABLE customer_profiles
  ADD COLUMN cover_preset_id text CHECK (cover_preset_id IN ('calf-at-sunrise','farm-meadow')),
  ADD COLUMN cover_media_id uuid REFERENCES private_media(id) ON DELETE SET NULL,
  ADD COLUMN cover_version bigint NOT NULL DEFAULT 0 CHECK (cover_version >= 0),
  ADD CONSTRAINT customer_cover_single_source CHECK (cover_preset_id IS NULL OR cover_media_id IS NULL);

-- Down Migration
ALTER TABLE customer_profiles
  DROP CONSTRAINT customer_cover_single_source,
  DROP COLUMN cover_version,
  DROP COLUMN cover_media_id,
  DROP COLUMN cover_preset_id;
-- Keep the expanded purpose constraint so stored covers and their pending
-- cleanup records remain readable during a rollback. Production rolls forward.
