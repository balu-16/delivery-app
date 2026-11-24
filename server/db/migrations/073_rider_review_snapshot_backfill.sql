-- Up Migration
-- Backfill review snapshots for in-flight applications (customize2 §3C):
-- UNDER_REVIEW rows get the effective pre-cutover requiredRiderDocuments
-- policy — the persisted app_config value when one exists, otherwise the
-- ConfigService default. APPROVED rows are deliberately left untouched:
-- their eligibility is already recorded and must not be rewritten.
-- Completion path: every UNDER_REVIEW row entered review only when a latest
-- non-REJECTED document existed for each then-required type, so each
-- backfilled row has a latest document per snapshot type to decide on. A
-- row that still cannot be completed (e.g. a type whose latest version is
-- REJECTED) can only reach UNDER_REVIEW again through the existing
-- editable PENDING/REJECTED replacement flow after a rejection, which
-- replaces the snapshot at that transition. Forward-only like 070: the
-- backfilled snapshots are the review of record from this point, so there
-- is no destructive reverse.
UPDATE rider_profiles
SET review_required_documents = expected.required
FROM (
  SELECT COALESCE(
    NULLIF(
      (SELECT ARRAY(SELECT jsonb_array_elements_text(value)) FROM app_config WHERE key = 'requiredRiderDocuments'),
      ARRAY[]::text[]
    ),
    ARRAY['licence', 'vehicle_rc', 'id_proof', 'bank_proof']::text[]
  ) AS required
) AS expected
WHERE status = 'UNDER_REVIEW' AND review_required_documents IS NULL;
