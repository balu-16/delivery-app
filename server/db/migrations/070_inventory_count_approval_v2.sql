-- Up Migration
-- Coordinated INVENTORY_COUNT approval cutover (customize2 §3A): the gated
-- stock-approval action moves from version 1 / STORE_MANAGER-checker to
-- version 2 / SUPER_ADMIN-checker. All unexpired PENDING rows created under
-- the old policy are migrated under the existing approval lock (701002, the
-- same lock MakerChecker takes for request/approve). IDs, maker, payload,
-- payload hash, expiry, and execution references are preserved. Terminal
-- rows (EXECUTED / REJECTED / EXPIRED) keep their original authority. The
-- migration appends one audit_log row per moved row recording the cutover.
-- Run while approval creation and execution are quiesced. Forward-only like
-- 013: terminal decisions retain their original authority and pending rows
-- are re-issued under the new policy, so there is no safe reverse.
SELECT pg_advisory_xact_lock(701002);
WITH migrated AS (
  UPDATE maker_checker_requests
  SET action_version = 2,
      required_role = 'SUPER_ADMIN'
  WHERE action = 'INVENTORY_COUNT'
    AND status = 'PENDING'
    AND expires_at > clock_timestamp()
    AND action_version = 1
  RETURNING id, maker_id
)
INSERT INTO audit_log (id, actor_id, action, subject_type, subject_id, details)
SELECT gen_random_uuid(), NULL, 'INVENTORY_COUNT_APPROVAL_MIGRATED', 'approval',
       id::text,
       jsonb_build_object(
         'action_version', 2,
         'required_role', 'SUPER_ADMIN',
         'maker_id', maker_id::text
       )
FROM migrated;
