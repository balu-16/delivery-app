-- Up Migration
-- Serialize partition creation, including delayed and restart-era samples.
CREATE FUNCTION ensure_location_partition(day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE label text := to_char(day, 'YYYYMMDD');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('rider_location_history_partition'));
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='rider_location_history_' || label) THEN
    EXECUTE format('CREATE TABLE public.rider_location_history_%s PARTITION OF public.rider_location_history FOR VALUES FROM (%L) TO (%L)', label, day, day + 1);
  END IF;
END $$;

-- Keep physical custody attached on failed delivery and retain the completing rider for authorized replay.
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='delivery_tasks'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%rider_id IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%ASSIGNED%';
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'delivery task custody constraint missing'; END IF;
  EXECUTE format('ALTER TABLE delivery_tasks DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE delivery_tasks ADD COLUMN custody_released_at timestamptz;
ALTER TABLE delivery_tasks ADD CONSTRAINT delivery_tasks_custody_check CHECK (
  (status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED','DELIVERED','FAILED') AND rider_id IS NOT NULL)
  OR (status = 'FAILED' AND rider_id IS NULL AND custody_released_at IS NOT NULL)
  OR (status IN ('UNASSIGNED','OFFERED','CANCELLED') AND rider_id IS NULL)
) NOT VALID;

DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='private_media'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%purpose%RIDER_KYC%';
  EXECUTE format('ALTER TABLE private_media DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE private_media ADD CONSTRAINT private_media_purpose_check CHECK (purpose IN ('RIDER_KYC','DELIVERY_POD'));
CREATE TABLE delivery_pod_media (media_id uuid PRIMARY KEY REFERENCES private_media(id), task_id uuid NOT NULL REFERENCES delivery_tasks(id), rider_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp());

-- Down Migration
DROP TABLE delivery_pod_media;
ALTER TABLE private_media DROP CONSTRAINT private_media_purpose_check;
ALTER TABLE private_media ADD CONSTRAINT private_media_kyc_only CHECK (purpose='RIDER_KYC') NOT VALID;
ALTER TABLE delivery_tasks DROP CONSTRAINT delivery_tasks_custody_check;
ALTER TABLE delivery_tasks DROP COLUMN custody_released_at;
ALTER TABLE delivery_tasks ADD CONSTRAINT delivery_tasks_original_custody_check CHECK ((status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')) = (rider_id IS NOT NULL)) NOT VALID;
DROP FUNCTION ensure_location_partition(date);
