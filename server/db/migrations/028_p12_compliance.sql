-- Up Migration
ALTER TABLE erasure_requests DROP CONSTRAINT erasure_requests_status_check;
ALTER TABLE erasure_requests ADD CONSTRAINT erasure_requests_status_check CHECK (status IN ('REQUESTED','BLOCKED','AWAITING_APPROVAL','PROCESSING','CLEANUP','COMPLETE','REJECTED'));
ALTER TABLE erasure_requests ADD COLUMN blockers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE erasure_requests ADD COLUMN requested_by uuid REFERENCES users(id);
ALTER TABLE erasure_requests ADD COLUMN approved_by uuid REFERENCES users(id);
ALTER TABLE erasure_requests ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE erasure_requests ADD COLUMN retry_after timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE erasure_requests ADD COLUMN identity_sync_id uuid REFERENCES identity_sync_operations(id);
ALTER TABLE erasure_requests ADD COLUMN cleanup_after timestamptz NOT NULL DEFAULT clock_timestamp();
DROP INDEX erasure_one_open_idx;
CREATE UNIQUE INDEX erasure_one_open_idx ON erasure_requests(user_id) WHERE status IN ('REQUESTED','BLOCKED','AWAITING_APPROVAL','PROCESSING','CLEANUP');
CREATE TABLE compliance_reviews (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('FRAUD','RECONCILIATION','APPROVAL')),
 subject_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), decision text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX compliance_reviews_subject_idx ON compliance_reviews(kind,subject_id,created_at DESC,id DESC);
CREATE TABLE privacy_legal_holds (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), released_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX privacy_legal_holds_active_idx ON privacy_legal_holds(user_id) WHERE released_at IS NULL;
ALTER TABLE private_media DROP CONSTRAINT private_media_state_check;
ALTER TABLE private_media ADD CONSTRAINT private_media_state_check CHECK (state IN ('PENDING','UPLOADING','STORED','ERASING'));
CREATE TABLE privacy_media_fences (
 owner_id uuid PRIMARY KEY REFERENCES users(id), ready_at timestamptz NOT NULL
);
CREATE TABLE privacy_media_cleanup_objects (
 owner_id uuid NOT NULL REFERENCES users(id), object_key text NOT NULL,
 PRIMARY KEY(owner_id,object_key)
);
CREATE TABLE private_media_promotions (
 media_id uuid NOT NULL REFERENCES private_media(id), object_key text NOT NULL,
 PRIMARY KEY(media_id,object_key)
);
CREATE TABLE compliance_export_jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), audience text NOT NULL CHECK(audience IN ('CUSTOMER','ADMIN')),
 kind text NOT NULL, filters jsonb NOT NULL DEFAULT '{}'::jsonb, request_key text NOT NULL, request_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETE','FAILED','EXPIRED')),
 object_key text, row_count bigint NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, retry_after timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz,
 UNIQUE(owner_id,audience,request_key)
);
CREATE INDEX compliance_export_owner_idx ON compliance_export_jobs(owner_id,created_at DESC,id DESC);
CREATE INDEX compliance_export_due_idx ON compliance_export_jobs(created_at,id) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE compliance_export_objects (
 object_key text PRIMARY KEY, job_id uuid NOT NULL REFERENCES compliance_export_jobs(id),
 remove_after timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE notifications ADD COLUMN retention_anonymized_at timestamptz;
-- Down Migration
ALTER TABLE notifications DROP COLUMN retention_anonymized_at;
DROP TABLE compliance_export_objects;
DROP TABLE compliance_export_jobs;
DROP TABLE private_media_promotions;
DROP TABLE privacy_media_cleanup_objects;
DROP TABLE privacy_media_fences;
UPDATE private_media SET state='PENDING' WHERE state='ERASING';
ALTER TABLE private_media DROP CONSTRAINT private_media_state_check;
ALTER TABLE private_media ADD CONSTRAINT private_media_state_check CHECK (state IN ('PENDING','UPLOADING','STORED'));
DROP TABLE privacy_legal_holds;
DROP TABLE compliance_reviews;
DROP INDEX erasure_one_open_idx;
ALTER TABLE erasure_requests DROP COLUMN cleanup_after, DROP COLUMN identity_sync_id, DROP COLUMN retry_after, DROP COLUMN updated_at, DROP COLUMN approved_by, DROP COLUMN requested_by, DROP COLUMN blockers;
UPDATE erasure_requests SET status='BLOCKED' WHERE status IN ('AWAITING_APPROVAL','PROCESSING','CLEANUP','REJECTED');
ALTER TABLE erasure_requests DROP CONSTRAINT erasure_requests_status_check;
ALTER TABLE erasure_requests ADD CONSTRAINT erasure_requests_status_check CHECK (status IN ('REQUESTED','BLOCKED','COMPLETE'));
CREATE UNIQUE INDEX erasure_one_open_idx ON erasure_requests(user_id) WHERE status='REQUESTED';
