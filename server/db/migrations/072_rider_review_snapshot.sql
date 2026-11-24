-- Up Migration
-- Rider review snapshot (customize2 §3C): the required-document list in
-- force when an application enters UNDER_REVIEW. The readiness transition
-- persists it in the same transaction as the status change, and the review
-- plus application reads consult it, so a later config change cannot move
-- the checklist mid-review. Nullable: PENDING/REJECTED rows have no
-- snapshot yet; APPROVED rows keep NULL unless they entered review after
-- this column exists. No backfill here — see 073.
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS review_required_documents text[];

-- Down Migration
ALTER TABLE rider_profiles DROP COLUMN IF EXISTS review_required_documents;
