-- Track E (customize2 §3E): app content + template overrides + stored rendered text.
-- Forward-only additive. No seeds: absent app_content row = unset (apps use
-- bundled defaults); absent override = defaults from notification_templates.
CREATE TABLE app_content (
 slot text NOT NULL CHECK (slot IN ('CUSTOMER_HOME_BANNER','CUSTOMER_OFFERS_CARD','RIDER_HOME_ANNOUNCEMENT','CUSTOMER_HELP','RIDER_HELP')),
 locale text NOT NULL CHECK (locale IN ('en','hi','te')),
 enabled boolean NOT NULL,
 title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200),
 body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
 image_media_id uuid REFERENCES catalog_media(id),
 destination text CHECK (destination IS NULL OR length(destination) BETWEEN 1 AND 500),
 start_at timestamptz,
 end_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (slot, locale),
 CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at)
);
CREATE TABLE app_content_history (
 id uuid PRIMARY KEY,
 slot text NOT NULL,
 locale text NOT NULL,
 version integer NOT NULL,
 enabled boolean NOT NULL,
 title text,
 body text,
 image_media_id uuid,
 destination text,
 start_at timestamptz,
 end_at timestamptz,
 updated_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX app_content_history_idx ON app_content_history(slot, locale, version DESC);
CREATE TABLE notification_template_overrides (
 template_key text NOT NULL CHECK (template_key ~ '^[a-z0-9_.]{1,80}$'),
 locale text NOT NULL CHECK (locale IN ('en','hi','te')),
 channel text NOT NULL CHECK (channel IN ('PUSH','EMAIL','INBOX')),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (template_key, locale, channel)
);
CREATE TABLE notification_template_history (
 id uuid PRIMARY KEY,
 template_key text NOT NULL,
 locale text NOT NULL,
 channel text NOT NULL,
 version integer NOT NULL,
 subject text NOT NULL,
 body text NOT NULL,
 updated_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notification_template_history_idx ON notification_template_history(template_key, locale, channel, version DESC);
ALTER TABLE notifications ADD COLUMN rendered_title text;
ALTER TABLE notifications ADD COLUMN rendered_body text;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog_media'::regclass AND conname = 'catalog_media_purpose_check') THEN
   ALTER TABLE catalog_media DROP CONSTRAINT catalog_media_purpose_check;
 END IF;
 ALTER TABLE catalog_media ADD CONSTRAINT catalog_media_purpose_check CHECK (purpose IN ('PRODUCT_IMAGE','CATALOG_IMPORT','IMPORT_REPORT','CONTENT_IMAGE'));
END $$;
