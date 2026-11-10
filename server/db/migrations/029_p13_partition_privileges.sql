-- Up Migration
-- These narrowly scoped functions are owned by the migration role. Runtime needs
-- EXECUTE, not ownership or CREATE/DROP on the schema.
CREATE OR REPLACE FUNCTION public.ensure_location_partitions(up_to date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d date; created integer := 0; label text; today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF up_to IS NULL OR up_to < today OR up_to > today + 2 THEN
    RAISE EXCEPTION 'invalid partition horizon';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('delivery.location.partitions'));
  FOR d IN SELECT gs::date FROM generate_series(today::timestamp, up_to::timestamp, interval '1 day') AS gs LOOP
    label := 'rider_location_history_' || to_char(d, 'YYYYMMDD');
    IF to_regclass(format('public.%I', label)) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I PARTITION OF public.rider_location_history FOR VALUES FROM (%L) TO (%L)', label, d, d + 1);
      created := created + 1;
    ELSIF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = to_regclass(format('public.%I', label)) AND inhparent = 'public.rider_location_history'::regclass) THEN
      RAISE EXCEPTION 'partition name is occupied';
    END IF;
  END LOOP;
  RETURN created;
END $$;
CREATE OR REPLACE FUNCTION public.drop_location_partition(day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE policy jsonb; days integer; label text; relation regclass;
BEGIN
  SELECT value INTO policy FROM public.app_config WHERE key = 'locationRetentionDays';
  IF NOT FOUND THEN days := 30;
  ELSIF jsonb_typeof(policy) = 'number' AND policy::text ~ '^[0-9]+$' AND length(policy::text) <= 3 THEN
    days := policy::text::integer;
    IF days < 1 OR days > 365 THEN RAISE EXCEPTION 'invalid location retention policy'; END IF;
  ELSE RAISE EXCEPTION 'invalid location retention policy'; END IF;
  IF day IS NULL OR (day::timestamp AT TIME ZONE 'UTC') + interval '2 days' >= clock_timestamp() - days * interval '1 day' THEN
    RAISE EXCEPTION 'partition is within retention';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('delivery.location.partitions'));
  label := 'rider_location_history_' || to_char(day, 'YYYYMMDD');
  relation := to_regclass(format('public.%I', label));
  IF relation IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation AND inhparent = 'public.rider_location_history'::regclass) THEN
    RAISE EXCEPTION 'not a location partition';
  END IF;
  EXECUTE format('DROP TABLE public.%I', label);
END $$;
CREATE OR REPLACE FUNCTION public.ensure_location_partition(day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE label text; relation regclass; today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF day IS NULL OR day < today - 365 OR day > today + 2 THEN RAISE EXCEPTION 'invalid partition day'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('delivery.location.partitions'));
  label := 'rider_location_history_' || to_char(day, 'YYYYMMDD');
  relation := to_regclass(format('public.%I', label));
  IF relation IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I PARTITION OF public.rider_location_history FOR VALUES FROM (%L) TO (%L)', label, day, day + 1);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation AND inhparent = 'public.rider_location_history'::regclass) THEN
    RAISE EXCEPTION 'partition name is occupied';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.ensure_location_partition(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_location_partitions(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drop_location_partition(date) FROM PUBLIC;

-- Down Migration
-- Forward-only: restoring invoker functions would reintroduce unsafe DDL privileges.
DO $$ BEGIN RAISE EXCEPTION 'migration 029 is forward-only'; END $$;
