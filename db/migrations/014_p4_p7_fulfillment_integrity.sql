-- Forward repair: preserve reservation cycles and valid partial fulfillment.
-- Up Migration
ALTER TABLE inventory_reservations ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK(generation>0);
CREATE TABLE inventory_reservation_cycles (
 order_id uuid NOT NULL, generation integer NOT NULL CHECK(generation>0),
 reservations jsonb NOT NULL, allocations jsonb NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(order_id,generation)
);
CREATE TRIGGER inventory_reservation_cycles_immutable BEFORE UPDATE OR DELETE ON inventory_reservation_cycles
 FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();
ALTER TABLE inventory_shortfall_obligations ADD COLUMN published_quantity bigint NOT NULL DEFAULT 0 CHECK(published_quantity>=0);
ALTER TABLE inventory_shortfall_obligations ADD COLUMN event_version bigint NOT NULL DEFAULT 0 CHECK(event_version>=0);
ALTER TABLE catalog_variants ADD COLUMN base_unit text NOT NULL DEFAULT 'PIECE' CHECK(base_unit IN ('PIECE','GRAM','MILLILITRE'));
-- Completed/cancelled tasks retain their assignee/start time as history.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='pick_tasks'::regclass AND contype='c'
  AND (pg_get_constraintdef(oid) LIKE '%assigned_to%' OR pg_get_constraintdef(oid) LIKE '%started_at%' OR pg_get_constraintdef(oid) LIKE '%completed_at%')
 LOOP EXECUTE format('ALTER TABLE pick_tasks DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE pick_tasks ADD CONSTRAINT pick_tasks_assignee_required CHECK(status NOT IN ('ASSIGNED','IN_PROGRESS') OR assigned_to IS NOT NULL);
ALTER TABLE pick_tasks ADD CONSTRAINT pick_tasks_start_required CHECK(status <> 'IN_PROGRESS' OR started_at IS NOT NULL);
ALTER TABLE pick_tasks ADD CONSTRAINT pick_tasks_completion_required CHECK(status <> 'COMPLETED' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL));
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='pick_items'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%PICKED%picked_qty%'
 LOOP EXECUTE format('ALTER TABLE pick_items DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE pick_items ADD CONSTRAINT pick_items_resolved_quantity_check
 CHECK((status NOT IN ('PICKED','SUBSTITUTED') OR (picked_qty>0 AND batch_id IS NOT NULL))
   AND (status<>'PENDING' OR picked_qty=0) AND (picked_qty=0 OR batch_id IS NOT NULL));
CREATE TABLE picking_operational_alerts (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), kind text NOT NULL,
 period date NOT NULL, UNIQUE(store_id,kind,period)
);
-- Down Migration
DROP TABLE picking_operational_alerts;
ALTER TABLE pick_tasks DROP CONSTRAINT pick_tasks_assignee_required;
ALTER TABLE pick_tasks DROP CONSTRAINT pick_tasks_start_required;
ALTER TABLE pick_tasks DROP CONSTRAINT pick_tasks_completion_required;
ALTER TABLE pick_items DROP CONSTRAINT pick_items_resolved_quantity_check;
ALTER TABLE catalog_variants DROP COLUMN base_unit;
ALTER TABLE inventory_shortfall_obligations DROP COLUMN published_quantity;
ALTER TABLE inventory_shortfall_obligations DROP COLUMN event_version;
DROP TABLE inventory_reservation_cycles;
ALTER TABLE inventory_reservations DROP COLUMN generation;
