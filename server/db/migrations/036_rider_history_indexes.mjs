// Build these indexes outside a transaction so writes can continue. If an
// interrupted concurrent build leaves an invalid index, repair it explicitly
// before rerunning this migration; IF NOT EXISTS alone would hide that state.
export async function up(pgm) {
  pgm.noTransaction();
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname IN ('rider_assignment_history_rider_idx','rider_delivered_history_idx') AND NOT i.indisvalid)
    THEN RAISE EXCEPTION 'Remove invalid rider history indexes before retrying migration 036'; END IF;
  END $$`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS rider_assignment_history_rider_idx
    ON task_assignment_history(rider_id,id DESC) WHERE action IN ('ASSIGNED','REASSIGNED')`);
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS rider_delivered_history_idx
    ON delivery_task_history(actor_id,created_at DESC) INCLUDE (task_id) WHERE status='DELIVERED'`);
}

export const down = false;
