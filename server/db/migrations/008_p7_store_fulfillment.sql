-- P7 store fulfillment: pick tasks, packing, handover verification, returns QC.
-- Order references stay FK-free until P6 introduces the orders tables (005/006 precedent);
-- 007_p6 (or its successor) adds the pick/order foreign keys before accepting live orders.
-- Up Migration
CREATE TABLE picking_operations (
 reference text PRIMARY KEY CHECK(length(reference) BETWEEN 1 AND 300), kind text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pick_tasks (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, store_id uuid NOT NULL REFERENCES stores(id),
 status text NOT NULL CHECK(status IN ('PENDING','ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED')),
 assigned_to uuid REFERENCES users(id), started_at timestamptz, sla_due_at timestamptz NOT NULL,
 completed_at timestamptz, completed_by uuid REFERENCES users(id), cancel_reason text,
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status IN ('ASSIGNED','IN_PROGRESS')) = (assigned_to IS NOT NULL)),
 CHECK((status = 'IN_PROGRESS') = (started_at IS NOT NULL)),
 CHECK((status = 'COMPLETED') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
 CHECK(status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
-- At most one active pick task per order (SYS-06); the confirmation consumer retries safely.
CREATE UNIQUE INDEX pick_tasks_order_active_idx ON pick_tasks(order_id) WHERE status NOT IN ('COMPLETED','CANCELLED');
CREATE INDEX pick_tasks_store_queue_idx ON pick_tasks(store_id, status, sla_due_at, id);
CREATE INDEX pick_tasks_assignee_idx ON pick_tasks(assigned_to, status);
CREATE INDEX pick_tasks_order_history_idx ON pick_tasks(order_id, created_at DESC);
CREATE TABLE pick_items (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES pick_tasks(id) ON DELETE CASCADE, order_item_id uuid NOT NULL,
 variant_id uuid NOT NULL REFERENCES catalog_variants(id), substitute_variant_id uuid REFERENCES catalog_variants(id),
 name_snapshot text NOT NULL CHECK(length(name_snapshot) BETWEEN 1 AND 300),
 expected_qty bigint NOT NULL CHECK(expected_qty > 0), picked_qty bigint NOT NULL DEFAULT 0 CHECK(picked_qty >= 0 AND picked_qty <= expected_qty),
 batch_id uuid REFERENCES inventory_batches(id),
 status text NOT NULL CHECK(status IN ('PENDING','PICKED','SHORT','SUBSTITUTED')),
 short_reason text CHECK(status <> 'SHORT' OR short_reason IN ('OUT_OF_STOCK','DAMAGED','EXPIRED','NOT_FOUND')),
 CHECK((status = 'PICKED') = (picked_qty > 0 AND batch_id IS NOT NULL)),
 CHECK(status <> 'SUBSTITUTED' OR substitute_variant_id IS NOT NULL),
 UNIQUE(task_id, order_item_id)
);
CREATE INDEX pick_items_task_idx ON pick_items(task_id, status);
CREATE TABLE pick_task_history (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES pick_tasks(id) ON DELETE CASCADE,
 version bigint NOT NULL CHECK(version > 0), previous_status text, status text NOT NULL,
 actor_id uuid REFERENCES users(id), reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(task_id, version)
);
CREATE FUNCTION reject_pick_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pick task history is append-only'; END $$;
CREATE TRIGGER pick_task_history_immutable BEFORE UPDATE OR DELETE ON pick_task_history FOR EACH ROW EXECUTE FUNCTION reject_pick_history_mutation();
CREATE TABLE packing_records (
 order_id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES pick_tasks(id), store_id uuid NOT NULL REFERENCES stores(id),
 bags integer NOT NULL CHECK(bags > 0 AND bags <= 100), seal_code text NOT NULL CHECK(length(seal_code) BETWEEN 1 AND 64),
 cold_chain boolean NOT NULL DEFAULT false, packed_by uuid NOT NULL REFERENCES users(id),
 packed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE handover_records (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, store_id uuid NOT NULL REFERENCES stores(id),
 verifier text NOT NULL CHECK(length(verifier) BETWEEN 32 AND 128), key_version integer NOT NULL DEFAULT 1 CHECK(key_version > 0),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0), locked_until timestamptz,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','VERIFIED','OVERRIDE')),
 verified_at timestamptz, verified_by uuid REFERENCES users(id), override_reason text,
 CHECK((state IN ('VERIFIED','OVERRIDE')) = (verified_at IS NOT NULL AND verified_by IS NOT NULL)),
 CHECK(state <> 'OVERRIDE' OR override_reason IS NOT NULL),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(order_id)
);
CREATE TABLE substitute_candidates (
 variant_id uuid NOT NULL REFERENCES catalog_variants(id), candidate_variant_id uuid NOT NULL REFERENCES catalog_variants(id),
 PRIMARY KEY(variant_id, candidate_variant_id), CHECK(variant_id <> candidate_variant_id)
);
CREATE INDEX substitute_candidates_reverse_idx ON substitute_candidates(candidate_variant_id, variant_id);
CREATE TABLE picking_sla_breaches (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES pick_tasks(id) ON DELETE CASCADE,
 store_id uuid NOT NULL REFERENCES stores(id), breached_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX picking_sla_breaches_store_idx ON picking_sla_breaches(store_id, breached_at DESC);
-- Down Migration
DROP TABLE picking_sla_breaches;
DROP TABLE substitute_candidates;
DROP TABLE handover_records;
DROP TABLE packing_records;
DROP TRIGGER pick_task_history_immutable ON pick_task_history;
DROP FUNCTION reject_pick_history_mutation();
DROP TABLE pick_task_history;
DROP TABLE pick_items;
DROP TABLE pick_tasks;
DROP TABLE picking_operations;
