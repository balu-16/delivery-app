-- Up Migration
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK(role IN ('CUSTOMER','RIDER','STORE_MANAGER','SUPPORT_AGENT','SUPER_ADMIN')) NOT VALID;
ALTER TABLE user_roles VALIDATE CONSTRAINT user_roles_role_check;
ALTER TABLE store_staff DROP CONSTRAINT store_staff_role_check;
ALTER TABLE store_staff ADD CONSTRAINT store_staff_role_check CHECK(role='STORE_MANAGER') NOT VALID;
ALTER TABLE store_staff VALIDATE CONSTRAINT store_staff_role_check;
-- Historical PICKER events remain readable; new store actions use STORE_MANAGER.
ALTER TABLE order_status_history DROP CONSTRAINT order_status_history_actor_type_check;
ALTER TABLE order_status_history ADD CONSTRAINT order_status_history_actor_type_check
  CHECK(actor_type IN ('CUSTOMER','ADMIN','SYSTEM','RIDER','PICKER','STORE_MANAGER')) NOT VALID;
ALTER TABLE order_status_history VALIDATE CONSTRAINT order_status_history_actor_type_check;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 043 is forward-only'; END $$;
