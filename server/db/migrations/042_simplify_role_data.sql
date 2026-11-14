-- Up Migration
-- Deploy with identity workers stopped. Preserve historical activity; picker
-- accounts are blocked rather than silently promoted to store manager.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM identity_sync_operations
    WHERE state <> 'COMPLETE' AND details->>'role' IN ('ADMIN','PICKER'))
  THEN RAISE EXCEPTION 'Resolve pending legacy identity synchronization before role migration'; END IF;
  IF EXISTS (SELECT 1 FROM identity_provisioning
    WHERE state <> 'COMPLETE' AND role IN ('ADMIN','PICKER'))
  THEN RAISE EXCEPTION 'Resolve in-progress legacy staff provisioning before role migration'; END IF;
  IF EXISTS (SELECT 1 FROM users GROUP BY cognito_sub HAVING count(*) > 1)
  THEN RAISE EXCEPTION 'Resolve subjects shared by customer and workforce profiles before role migration'; END IF;
  IF EXISTS (SELECT 1 FROM user_roles WHERE role <> 'PICKER' GROUP BY user_id
    HAVING count(DISTINCT CASE WHEN role='ADMIN' THEN 'SUPER_ADMIN' ELSE role END)>1)
  THEN RAISE EXCEPTION 'Resolve accounts with multiple application roles before role migration'; END IF;
END $$;

INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
  SELECT gen_random_uuid(),NULL,'LEGACY_PICKER_BLOCKED','user',u.id::text,'{}'::jsonb
  FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='PICKER'
  WHERE NOT EXISTS (SELECT 1 FROM user_roles other WHERE other.user_id=u.id AND other.role<>'PICKER');
UPDATE users SET status='BLOCKED',auth_version=auth_version+1,updated_at=clock_timestamp()
  WHERE id IN (SELECT user_id FROM user_roles WHERE role='PICKER')
  AND NOT EXISTS (SELECT 1 FROM user_roles other WHERE other.user_id=users.id AND other.role<>'PICKER');
DELETE FROM store_staff WHERE role='PICKER';
DELETE FROM user_roles WHERE role='PICKER';
DELETE FROM user_roles a USING user_roles b
  WHERE a.user_id=b.user_id AND a.role='ADMIN' AND b.role='SUPER_ADMIN';
UPDATE user_roles SET role='SUPER_ADMIN' WHERE role='ADMIN';
UPDATE maker_checker_requests SET required_role='SUPER_ADMIN' WHERE status='PENDING' AND required_role='ADMIN';
INSERT INTO local_identity_groups(pool,username,role)
  SELECT pool,username,'SUPER_ADMIN' FROM local_identity_groups WHERE role='ADMIN' ON CONFLICT DO NOTHING;
DELETE FROM local_identity_groups WHERE role IN ('ADMIN','PICKER');

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 042 is forward-only'; END $$;
