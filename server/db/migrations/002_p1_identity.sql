-- P1 identity/policy. Forward-only in production; down is development/test only.
-- Up Migration
CREATE TABLE users (
  id uuid PRIMARY KEY, pool text NOT NULL CHECK (pool IN ('CUSTOMER','WORKFORCE')),
  cognito_sub text NOT NULL, normalized_email text NOT NULL, name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','DELETED')),
  email_verified boolean NOT NULL DEFAULT false, auth_version bigint NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(pool,cognito_sub), UNIQUE(pool,normalized_email)
);
CREATE TABLE identity_sync_operations (seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL, state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN ('REQUESTED','RUNNING','COMPLETE')), lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz);
CREATE INDEX identity_sync_due_idx ON identity_sync_operations(next_attempt_at,seq) WHERE state <> 'COMPLETE';
CREATE TABLE identity_status_history (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), actor_id uuid REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK (role IN ('CUSTOMER','RIDER','PICKER','STORE_MANAGER','SUPPORT_AGENT','ADMIN','SUPER_ADMIN')),
  PRIMARY KEY(user_id,role)
);
CREATE TABLE customer_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), locale text NOT NULL DEFAULT 'en' CHECK(locale IN ('en','hi','te')));
CREATE TABLE staff_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), employee_code text UNIQUE);
-- Store FK is added by P2 after stores exist.
CREATE TABLE store_staff (user_id uuid NOT NULL REFERENCES users(id), store_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('PICKER','STORE_MANAGER')), PRIMARY KEY(user_id,store_id,role));
CREATE INDEX store_staff_store_idx ON store_staff(store_id,user_id);
CREATE TABLE rider_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED','SUSPENDED')), vehicle_type text, vehicle_no text, home_store_id uuid);
CREATE TABLE private_media (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK(purpose='RIDER_KYC'), content_type text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes > 0), state text NOT NULL CHECK(state IN ('PENDING','UPLOADING','STORED')), upload_nonce uuid NOT NULL, file_key uuid, lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE rider_documents (id uuid PRIMARY KEY, rider_id uuid NOT NULL REFERENCES rider_profiles(user_id), document_type text NOT NULL, media_id uuid NOT NULL, status text NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')), reviewed_by uuid REFERENCES users(id), reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX rider_documents_rider_idx ON rider_documents(rider_id,document_type,created_at DESC);
CREATE TABLE consents (user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL, version text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(), ip inet, PRIMARY KEY(user_id,type,version));
CREATE TABLE audit_log (id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, subject_type text NOT NULL, subject_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX audit_subject_idx ON audit_log(subject_type,subject_id,created_at DESC);
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TABLE config_history (id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), key text NOT NULL, old_value jsonb, new_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE app_config (key text PRIMARY KEY, value jsonb NOT NULL, version bigint NOT NULL DEFAULT 1, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, version bigint NOT NULL DEFAULT 1, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE maker_checker_requests (id uuid PRIMARY KEY, action text NOT NULL, action_version integer NOT NULL CHECK(action_version > 0), payload jsonb NOT NULL, payload_hash text NOT NULL, maker_id uuid NOT NULL REFERENCES users(id), checker_id uuid REFERENCES users(id), required_role text NOT NULL, status text NOT NULL CHECK(status IN ('PENDING','EXECUTED','EXPIRED','REJECTED')), expires_at timestamptz NOT NULL, execution_key uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), executed_at timestamptz);
CREATE INDEX approvals_pending_idx ON maker_checker_requests(expires_at) WHERE status='PENDING';
CREATE TABLE local_identity_directory (pool text NOT NULL CHECK(pool IN ('CUSTOMER','WORKFORCE')), username text NOT NULL, sub text NOT NULL, email text NOT NULL, name text NOT NULL, email_verified boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false, PRIMARY KEY(pool,username), UNIQUE(pool,sub), UNIQUE(pool,email));
CREATE TABLE local_identity_groups (pool text NOT NULL, username text NOT NULL, role text NOT NULL, PRIMARY KEY(pool,username,role), FOREIGN KEY(pool,username) REFERENCES local_identity_directory(pool,username) ON DELETE CASCADE);
CREATE TABLE identity_provisioning (id uuid PRIMARY KEY, normalized_email text NOT NULL UNIQUE, username text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL, state text NOT NULL CHECK(state IN ('REQUESTED','REMOTE_CREATED','COMPENSATION_REQUIRED','COMPLETE')), cognito_sub text, lease_token uuid, lease_until timestamptz, compensation_attempts integer NOT NULL DEFAULT 0, compensation_next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE erasure_requests (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL CHECK(status IN ('REQUESTED','BLOCKED','COMPLETE')), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE UNIQUE INDEX erasure_one_open_idx ON erasure_requests(user_id) WHERE status='REQUESTED';
-- Down Migration
DROP TABLE erasure_requests;
DROP TABLE identity_provisioning;
DROP TABLE local_identity_groups;
DROP TABLE local_identity_directory;
DROP TABLE maker_checker_requests;
DROP TABLE feature_flags;
DROP TABLE app_config;
DROP TABLE config_history;
DROP TRIGGER audit_append_only ON audit_log;
DROP FUNCTION reject_audit_mutation();
DROP TABLE audit_log;
DROP TABLE consents;
DROP TABLE rider_documents;
DROP TABLE private_media;
DROP TABLE rider_profiles;
DROP TABLE store_staff;
DROP TABLE staff_profiles;
DROP TABLE customer_profiles;
DROP TABLE user_roles;
DROP TABLE identity_status_history;
DROP TABLE identity_sync_operations;
DROP TABLE users;
