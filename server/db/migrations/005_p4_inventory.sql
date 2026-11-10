-- Inventory quantities are whole saleable units of a variant. Conversion occurs before receipt.
-- Up Migration
CREATE UNIQUE INDEX inventory_count_approval_reference_idx ON maker_checker_requests ((payload->>'maker'),(payload->>'storeId'),(payload->>'reference')) WHERE action='INVENTORY_COUNT';
CREATE TABLE inventory_category_shelf_life (
 category_id uuid PRIMARY KEY REFERENCES catalog_categories(id), min_seconds integer NOT NULL CHECK(min_seconds >= 0), version bigint NOT NULL DEFAULT 1 CHECK(version > 0)
);
CREATE TRIGGER inventory_shelf_life_revision AFTER INSERT OR UPDATE OR DELETE ON inventory_category_shelf_life FOR EACH STATEMENT EXECUTE FUNCTION bump_catalog_revision();
CREATE TABLE inventory_batches (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, variant_id uuid NOT NULL, batch_code text NOT NULL,
 expires_at timestamptz, state text NOT NULL CHECK(state IN ('ACTIVE','QUARANTINED','DAMAGED')),
 on_hand bigint NOT NULL CHECK(on_hand >= 0), reserved bigint NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= on_hand),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), maintenance_checked_at timestamptz,
 FOREIGN KEY(store_id,variant_id) REFERENCES store_inventory(store_id,variant_id), UNIQUE(store_id,variant_id,batch_code)
);
CREATE TABLE inventory_batch_history (
 id bigserial PRIMARY KEY, batch_id uuid NOT NULL REFERENCES inventory_batches(id), previous_state text, state text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION record_inventory_batch_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN INSERT INTO inventory_batch_history(batch_id,previous_state,state) VALUES(NEW.id,NULL,NEW.state);
 ELSIF OLD.state IS DISTINCT FROM NEW.state THEN INSERT INTO inventory_batch_history(batch_id,previous_state,state) VALUES(NEW.id,OLD.state,NEW.state); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_batch_state_history AFTER INSERT OR UPDATE OF state ON inventory_batches FOR EACH ROW EXECUTE FUNCTION record_inventory_batch_state();
CREATE INDEX inventory_batches_fefo_idx ON inventory_batches(store_id,variant_id,expires_at,id) WHERE state='ACTIVE';
CREATE TABLE inventory_operations (
 reference text PRIMARY KEY CHECK(length(reference) BETWEEN 1 AND 300), kind text NOT NULL, request_hash text NOT NULL,
 result jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE inventory_count_claims (
 actor_id uuid NOT NULL REFERENCES users(id), store_id uuid NOT NULL REFERENCES stores(id), reference text NOT NULL, request_hash text NOT NULL, approval_required boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,store_id,reference)
);
CREATE TABLE inventory_approval_keys (
 actor_id uuid NOT NULL REFERENCES users(id), reference text NOT NULL, approval_id uuid NOT NULL REFERENCES maker_checker_requests(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,reference)
);
CREATE TABLE inventory_manual_adjustments (
 actor_id uuid NOT NULL REFERENCES users(id), store_id uuid NOT NULL REFERENCES stores(id), reference text NOT NULL, request_hash text NOT NULL, counted bigint NOT NULL CHECK(counted >= 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,store_id,reference)
);
CREATE TABLE inventory_ledger (
 id uuid PRIMARY KEY, reference text NOT NULL REFERENCES inventory_operations(reference), store_id uuid NOT NULL,
 variant_id uuid NOT NULL, batch_id uuid NOT NULL REFERENCES inventory_batches(id), kind text NOT NULL,
 on_hand_delta bigint NOT NULL, reserved_delta bigint NOT NULL, actor_id uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), FOREIGN KEY(store_id,variant_id) REFERENCES store_inventory(store_id,variant_id),
 CHECK(on_hand_delta <> 0 OR reserved_delta <> 0)
);
CREATE INDEX inventory_ledger_lookup_idx ON inventory_ledger(store_id,variant_id,created_at DESC,id);
CREATE FUNCTION reject_inventory_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'inventory ledger is append-only'; END $$;
CREATE TRIGGER inventory_count_claims_immutable BEFORE UPDATE OR DELETE ON inventory_count_claims FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();
CREATE TRIGGER inventory_batch_history_immutable BEFORE UPDATE OR DELETE ON inventory_batch_history FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();
CREATE TRIGGER inventory_ledger_immutable BEFORE UPDATE OR DELETE ON inventory_ledger FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();
CREATE TABLE inventory_reservations (
 order_id uuid NOT NULL, store_id uuid NOT NULL, variant_id uuid NOT NULL, quantity bigint NOT NULL CHECK(quantity>0),
 state text NOT NULL CHECK(state IN ('HELD','COMMITTED','RESOLVED')), expires_at timestamptz,
 target_delivery_at timestamptz NOT NULL, resolved_kind text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(order_id,store_id,variant_id), FOREIGN KEY(store_id,variant_id) REFERENCES store_inventory(store_id,variant_id),
 CHECK((state='HELD' AND expires_at IS NOT NULL) OR (state<>'HELD' AND expires_at IS NULL))
);
CREATE TABLE inventory_reservation_history (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0), previous_state text, state text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(order_id,version)
);
CREATE TRIGGER inventory_reservation_history_immutable BEFORE UPDATE OR DELETE ON inventory_reservation_history FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();
CREATE INDEX inventory_reservations_expiry_idx ON inventory_reservations(expires_at,order_id) WHERE state='HELD';
CREATE TABLE inventory_allocations (
 order_id uuid NOT NULL, store_id uuid NOT NULL, variant_id uuid NOT NULL, batch_id uuid NOT NULL REFERENCES inventory_batches(id),
 quantity bigint NOT NULL CHECK(quantity>0), PRIMARY KEY(order_id,store_id,variant_id,batch_id),
 FOREIGN KEY(order_id,store_id,variant_id) REFERENCES inventory_reservations(order_id,store_id,variant_id)
);
CREATE INDEX inventory_allocations_batch_idx ON inventory_allocations(batch_id,order_id,store_id,variant_id);
CREATE TABLE inventory_returns (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, store_id uuid NOT NULL, variant_id uuid NOT NULL, batch_id uuid NOT NULL UNIQUE REFERENCES inventory_batches(id), quantity bigint NOT NULL CHECK(quantity>0), status text NOT NULL CHECK(status IN ('QUARANTINED','APPROVED','REJECTED')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), inspected_by uuid REFERENCES users(id), inspected_at timestamptz, reason text
);
CREATE INDEX inventory_returns_order_idx ON inventory_returns(order_id,store_id,variant_id);
CREATE TABLE inventory_shortfall_obligations (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, store_id uuid NOT NULL, variant_id uuid NOT NULL, batch_id uuid NOT NULL REFERENCES inventory_batches(id),
 quantity bigint NOT NULL CHECK(quantity>0), reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_at timestamptz,
 UNIQUE(order_id,store_id,variant_id,batch_id,reason)
);
CREATE INDEX inventory_shortfall_open_order_idx ON inventory_shortfall_obligations(order_id,batch_id) WHERE resolved_at IS NULL;
CREATE OR REPLACE VIEW inventory_saleable_availability AS
 SELECT i.store_id,i.variant_id,COALESCE(sum(b.on_hand-b.reserved) FILTER (WHERE b.state='ACTIVE' AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()+COALESCE(s.min_seconds,0)*interval '1 second')),0)::bigint AS available,
 min(b.expires_at-COALESCE(s.min_seconds,0)*interval '1 second') FILTER (WHERE b.state='ACTIVE' AND b.on_hand>b.reserved AND b.expires_at-COALESCE(s.min_seconds,0)*interval '1 second'>clock_timestamp()) AS next_change
 FROM store_inventory i JOIN catalog_variants v ON v.id=i.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id LEFT JOIN inventory_batches b ON b.store_id=i.store_id AND b.variant_id=i.variant_id GROUP BY i.store_id,i.variant_id;
-- Down Migration
CREATE OR REPLACE VIEW inventory_saleable_availability AS
 SELECT store_id,variant_id,(on_hand-reserved)::bigint AS available,NULL::timestamptz AS next_change FROM store_inventory;
DROP TABLE inventory_shortfall_obligations;
DROP TABLE inventory_returns;
DROP TABLE inventory_allocations;
DROP TRIGGER inventory_reservation_history_immutable ON inventory_reservation_history;
DROP TABLE inventory_reservation_history;
DROP TABLE inventory_reservations;
DROP TRIGGER inventory_ledger_immutable ON inventory_ledger;
DROP TRIGGER inventory_batch_history_immutable ON inventory_batch_history;
DROP TRIGGER inventory_count_claims_immutable ON inventory_count_claims;
DROP FUNCTION reject_inventory_ledger_mutation();
DROP TABLE inventory_ledger;
DROP TABLE inventory_operations;
DROP TABLE inventory_manual_adjustments;
DROP TABLE inventory_approval_keys;
DROP TABLE inventory_count_claims;
DROP TRIGGER inventory_batch_state_history ON inventory_batches;
DROP FUNCTION record_inventory_batch_state();
DROP TABLE inventory_batch_history;
DROP TABLE inventory_batches;
DROP TRIGGER inventory_shelf_life_revision ON inventory_category_shelf_life;
DROP TABLE inventory_category_shelf_life;
DROP INDEX inventory_count_approval_reference_idx;
