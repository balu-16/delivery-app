-- Up Migration
-- Durable terminal rejections for idempotent placement requests (plan2 §1).
-- A rejection is recorded only by the fenced owner after proving its own
-- transaction did not commit and no order exists for the operation. Unlike the
-- cached response, rejection columns are permanent: pruneResponses must never
-- clear them, so late status checks still report REJECTED instead of UNKNOWN.
ALTER TABLE idempotency_keys ADD COLUMN rejection_code text NULL
  CHECK (rejection_code IS NULL OR rejection_code ~ '^[A-Z][A-Z0-9_]{2,63}$');
ALTER TABLE idempotency_keys ADD COLUMN rejection_status integer NULL
  CHECK (rejection_status IS NULL OR (rejection_status BETWEEN 100 AND 599));
ALTER TABLE idempotency_keys ADD COLUMN rejected_at timestamptz NULL;

-- Down Migration
ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS rejected_at;
ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS rejection_status;
ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS rejection_code;
