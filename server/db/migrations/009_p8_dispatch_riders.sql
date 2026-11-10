-- P8 dispatch, riders, tracking, COD and earnings (plan 6.1 P8 row; D20/D21/D22).
-- delivery_tasks.order_id references 007's orders table directly (007 exists).
-- Money columns are bigint paise as decimal strings at the API boundary.
-- Retention: rider_location_history is RANGE-partitioned by day; the retention
-- worker creates tomorrow's partition ahead of midnight and drops partitions
-- older than the configured retention via drop_location_partition(date).
-- Rollback note: development migrate:down runs the Down Migration section
-- (dropping these tables in reverse dependency order); production corrections
-- use reviewed forward migrations only.
-- Up Migration
CREATE TABLE dispatch_operations (
 reference text PRIMARY KEY CHECK(length(reference) BETWEEN 1 AND 300), kind text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Operational rider state (approval itself stays in P1 rider_profiles). The
-- last accepted point is stored here so dispatch can revalidate candidate
-- freshness under row locks (D22: Redis GEO membership never proves eligibility).
CREATE TABLE rider_status (
 rider_id uuid PRIMARY KEY REFERENCES users(id),
 online boolean NOT NULL DEFAULT false,
 last_heartbeat_at timestamptz,
 last_location geography(Point,4326),
 last_location_at timestamptz,
 last_location_source text CHECK(last_location_source IN ('GPS','MANUAL')),
 active_tasks integer NOT NULL DEFAULT 0 CHECK(active_tasks >= 0),
 idle_since timestamptz,
 unreachable_since timestamptz,
 suspended_at timestamptz,
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rider_status_online_idx ON rider_status(online, last_location_at) WHERE online;
-- GiST serves the DB fallback candidate query when Redis GEO is unavailable.
CREATE INDEX rider_status_location_idx ON rider_status USING GIST(last_location) WHERE last_location IS NOT NULL;
CREATE TABLE rider_shifts (
 id uuid PRIMARY KEY, rider_id uuid NOT NULL REFERENCES users(id),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
 end_reason text CHECK(ended_at IS NULL OR end_reason IN ('RIDER','AUTO_INACTIVITY','MAX_HOURS','SUSPENSION','SYSTEM')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX rider_shifts_rider_idx ON rider_shifts(rider_id, started_at DESC);
CREATE INDEX rider_shifts_open_idx ON rider_shifts(rider_id) WHERE ended_at IS NULL;
-- Daily partitions; uniqueness must include the timestamp on every partition.
CREATE TABLE rider_location_history (
 rider_id uuid NOT NULL REFERENCES users(id),
 ts timestamptz NOT NULL,
 location geography(Point,4326) NOT NULL,
 accuracy_m double precision CHECK(accuracy_m IS NULL OR accuracy_m >= 0),
 speed_mps double precision CHECK(speed_mps IS NULL OR speed_mps >= 0),
 is_mock boolean NOT NULL DEFAULT false,
 battery_pct smallint CHECK(battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100),
 order_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (rider_id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX rider_location_history_order_idx ON rider_location_history(order_id, ts DESC);
CREATE FUNCTION ensure_location_partitions(up_to date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE d date; created integer := 0; label text;
BEGIN
  FOR d IN SELECT gs::date FROM generate_series(
      date_trunc('day', clock_timestamp()), up_to::timestamp, interval '1 day') AS gs
  LOOP
    label := to_char(d, 'YYYYMMDD');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'rider_location_history_' || label) THEN
      EXECUTE format(
        'CREATE TABLE rider_location_history_%s PARTITION OF rider_location_history FOR VALUES FROM (%L) TO (%L)',
        label, d, d + 1);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;
CREATE FUNCTION drop_location_partition(day date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS rider_location_history_%s', to_char(day, 'YYYYMMDD'));
END $$;
-- Initial partitions: today and tomorrow; the retention worker extends daily.
DO $$ BEGIN PERFORM ensure_location_partitions(date_trunc('day', clock_timestamp())::date + 1); END $$;
-- One delivery task per order (SYS-06 half); attempt_no advances on every
-- pre-pickup unassign/re-dispatch (11.3). Store handover must be verified
-- before pickup (P7 handover_records), delivery only after pickup.
CREATE TABLE delivery_tasks (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), store_id uuid NOT NULL REFERENCES stores(id),
 customer_user_id uuid REFERENCES users(id),
 status text NOT NULL CHECK(status IN ('UNASSIGNED','OFFERED','ASSIGNED','AT_STORE','PICKED_UP','ARRIVED','DELIVERED','FAILED','CANCELLED')),
 rider_id uuid REFERENCES users(id), attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no >= 0),
 offered_rider_id uuid REFERENCES users(id),
 pickup_at timestamptz, arrived_store_at timestamptz, arrived_customer_at timestamptz,
 dispatched_at timestamptz, delivered_at timestamptz,
 failure_reason text CHECK(status <> 'FAILED' OR failure_reason IS NOT NULL),
 failure_evidence jsonb, pod_media_id uuid,
 geofence_store_distance_m integer CHECK(geofence_store_distance_m IS NULL OR geofence_store_distance_m >= 0),
 geofence_customer_distance_m integer CHECK(geofence_customer_distance_m IS NULL OR geofence_customer_distance_m >= 0),
 eta_min_minutes smallint CHECK(eta_min_minutes IS NULL OR eta_min_minutes >= 0),
 eta_max_minutes smallint CHECK(eta_max_minutes IS NULL OR eta_max_minutes >= eta_min_minutes),
 eta_updated_at timestamptz,
 dispatch_attempts integer NOT NULL DEFAULT 0 CHECK(dispatch_attempts >= 0),
 next_dispatch_at timestamptz,
 no_rider_alerted_at timestamptz,
 distance_metres integer CHECK(distance_metres IS NULL OR distance_metres >= 0),
 cancel_reason text CHECK(status <> 'CANCELLED' OR cancel_reason IS NOT NULL),
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')) = (rider_id IS NOT NULL)),
 CHECK((status = 'OFFERED') = (offered_rider_id IS NOT NULL)),
 CHECK(status NOT IN ('PICKED_UP','ARRIVED','DELIVERED') OR pickup_at IS NOT NULL),
 -- Timestamp implications are one-directional: custody states require the
 -- timestamps, while terminal rows keep them as historical facts.
 CHECK(status NOT IN ('AT_STORE','PICKED_UP','ARRIVED','DELIVERED') OR arrived_store_at IS NOT NULL),
 CHECK(status NOT IN ('ARRIVED','DELIVERED') OR arrived_customer_at IS NOT NULL),
 CHECK(status NOT IN ('DELIVERED') OR delivered_at IS NOT NULL),
 CHECK(eta_min_minutes IS NULL OR eta_max_minutes IS NOT NULL)
);
-- At most one active delivery task per order; the confirmation consumer is
-- idempotent per delivery and retries safely against this index.
CREATE UNIQUE INDEX delivery_tasks_order_active_idx ON delivery_tasks(order_id) WHERE status NOT IN ('DELIVERED','FAILED','CANCELLED');
-- Dispatch queue scan: due unassigned tasks for the engine (SKIP LOCKED path).
CREATE INDEX delivery_tasks_dispatch_idx ON delivery_tasks(status, next_dispatch_at, id) WHERE status IN ('UNASSIGNED','OFFERED');
-- Rider manifests and capacity checks (lock-friendly deterministic order).
CREATE INDEX delivery_tasks_rider_idx ON delivery_tasks(rider_id, status, id);
CREATE INDEX delivery_tasks_order_history_idx ON delivery_tasks(order_id, created_at DESC);
-- Store-level dispatch backlog feeds no-rider signals.
CREATE INDEX delivery_tasks_store_idx ON delivery_tasks(store_id, status, created_at DESC);
CREATE TABLE rider_offers (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES delivery_tasks(id) ON DELETE CASCADE,
 rider_id uuid NOT NULL REFERENCES users(id), attempt_no integer NOT NULL CHECK(attempt_no >= 0),
 status text NOT NULL CHECK(status IN ('SENT','ACCEPTED','DECLINED','EXPIRED','REVOKED')),
 sent_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 responded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status IN ('ACCEPTED','DECLINED')) = (responded_at IS NOT NULL)),
 CHECK(expires_at > sent_at)
);
-- One live offer per (task, rider, attempt): terminal offers (expired,
-- declined, revoked) do not block later re-offers after widening.
CREATE UNIQUE INDEX rider_offers_task_rider_attempt_idx ON rider_offers(task_id, rider_id, attempt_no) WHERE status IN ('SENT','ACCEPTED');
-- Live offer lookup for a rider (poll fallback) and expiry sweeps.
CREATE INDEX rider_offers_rider_open_idx ON rider_offers(rider_id, status, expires_at) WHERE status = 'SENT';
CREATE INDEX rider_offers_task_idx ON rider_offers(task_id, status, sent_at DESC);
CREATE TABLE task_assignment_history (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES delivery_tasks(id) ON DELETE CASCADE,
 attempt_no integer NOT NULL CHECK(attempt_no >= 0), rider_id uuid REFERENCES users(id),
 action text NOT NULL CHECK(action IN ('ASSIGNED','REASSIGNED','UNASSIGNED','SYSTEM_UNASSIGNED','ESCALATED')),
 actor_id uuid REFERENCES users(id), reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX task_assignment_history_task_idx ON task_assignment_history(task_id, created_at);
-- Every delivery task transition writes history with the same version (SYS-08).
CREATE TABLE delivery_task_history (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES delivery_tasks(id) ON DELETE CASCADE,
 version bigint NOT NULL CHECK(version > 0), previous_status text, status text NOT NULL,
 actor_id uuid REFERENCES users(id), reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(task_id, version)
);
CREATE FUNCTION reject_delivery_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery task history is append-only'; END $$;
CREATE TRIGGER delivery_task_history_immutable BEFORE UPDATE OR DELETE ON delivery_task_history FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();
-- Earnings are computed exactly once per delivered task (UNIQUE(task_id)).
CREATE TABLE rider_earnings (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES delivery_tasks(id) ON DELETE CASCADE,
 rider_id uuid NOT NULL REFERENCES users(id), order_id uuid NOT NULL REFERENCES orders(id),
 base_paise bigint NOT NULL CHECK(base_paise >= 0), distance_paise bigint NOT NULL CHECK(distance_paise >= 0),
 detention_paise bigint NOT NULL CHECK(detention_paise >= 0), incentive_paise bigint NOT NULL DEFAULT 0 CHECK(incentive_paise >= 0),
 tip_paise bigint NOT NULL CHECK(tip_paise >= 0), adjustment_paise bigint NOT NULL DEFAULT 0 CHECK(adjustment_paise >= 0),
 total_paise bigint NOT NULL CHECK(total_paise >= 0), distance_metres integer NOT NULL CHECK(distance_metres >= 0),
 detention_minutes integer NOT NULL DEFAULT 0 CHECK(detention_minutes >= 0),
 payout_reference text,
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(total_paise = base_paise + distance_paise + detention_paise + incentive_paise + tip_paise + adjustment_paise)
);
CREATE INDEX rider_earnings_rider_idx ON rider_earnings(rider_id, computed_at DESC);
CREATE INDEX rider_earnings_payout_input_idx ON rider_earnings(rider_id, computed_at) WHERE payout_reference IS NULL;
CREATE TABLE rider_cash_ledger (
 id uuid PRIMARY KEY, rider_id uuid NOT NULL REFERENCES users(id),
 delta_paise bigint NOT NULL,
 reason text NOT NULL CHECK(reason IN ('COD_COLLECTED','COD_DEPOSIT','ADJUSTMENT')),
 ref_type text NOT NULL, ref_id text NOT NULL,
 balance_after bigint NOT NULL CHECK(balance_after >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (rider_id, ref_type, ref_id, reason)
);
CREATE INDEX rider_cash_ledger_rider_idx ON rider_cash_ledger(rider_id, created_at DESC, id);
CREATE FUNCTION reject_p8_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rider cash ledger is append-only'; END $$;
CREATE TRIGGER rider_cash_ledger_immutable BEFORE UPDATE OR DELETE ON rider_cash_ledger FOR EACH ROW EXECUTE FUNCTION reject_p8_ledger_mutation();
-- Store-manager recorded COD deposits (P11 wires admin/store endpoints; the
-- contract exists now so cash limits and payout netting are testable).
CREATE TABLE cod_settlements (
 id uuid PRIMARY KEY, rider_id uuid NOT NULL REFERENCES users(id),
 store_id uuid REFERENCES stores(id), amount_paise bigint NOT NULL CHECK(amount_paise > 0),
 deposit_reference text NOT NULL UNIQUE CHECK(length(deposit_reference) BETWEEN 1 AND 150),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CLEARED')),
 discrepancy_paise bigint NOT NULL DEFAULT 0 CHECK(discrepancy_paise >= 0),
 recorded_by uuid REFERENCES users(id), cleared_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state = 'CLEARED' OR cleared_at IS NULL)
);
CREATE INDEX cod_settlements_rider_idx ON cod_settlements(rider_id, created_at DESC);
CREATE TABLE cod_mismatches (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
 expected_paise bigint NOT NULL CHECK(expected_paise >= 0), collected_paise bigint NOT NULL CHECK(collected_paise >= 0),
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED')),
 resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state = 'OPEN' OR resolved_at IS NOT NULL)
);
CREATE INDEX cod_mismatches_open_idx ON cod_mismatches(state, created_at) WHERE state = 'OPEN';
-- Down Migration
DROP TABLE cod_mismatches;
DROP TABLE cod_settlements;
DROP TRIGGER rider_cash_ledger_immutable ON rider_cash_ledger;
DROP TABLE rider_cash_ledger;
DROP FUNCTION reject_p8_ledger_mutation();
DROP TABLE rider_earnings;
DROP TRIGGER delivery_task_history_immutable ON delivery_task_history;
DROP TABLE delivery_task_history;
DROP FUNCTION reject_delivery_history_mutation();
DROP TABLE task_assignment_history;
DROP TABLE rider_offers;
DROP TABLE delivery_tasks;
DROP TABLE rider_location_history;
DROP FUNCTION drop_location_partition(date);
DROP FUNCTION ensure_location_partitions(date);
DROP TABLE rider_shifts;
DROP TABLE rider_status;
DROP TABLE dispatch_operations;
