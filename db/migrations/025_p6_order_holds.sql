-- Up Migration
ALTER TABLE orders ADD COLUMN on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN hold_reason text;
ALTER TABLE orders ADD COLUMN hold_actor_id uuid REFERENCES users(id);
ALTER TABLE orders ADD COLUMN held_at timestamptz;
ALTER TABLE orders ADD CONSTRAINT order_hold_details_check CHECK (
  (on_hold AND hold_reason IS NOT NULL AND hold_actor_id IS NOT NULL AND held_at IS NOT NULL)
  OR (NOT on_hold AND hold_reason IS NULL AND hold_actor_id IS NULL AND held_at IS NULL)
);

-- Down Migration
ALTER TABLE orders DROP CONSTRAINT order_hold_details_check;
ALTER TABLE orders DROP COLUMN held_at;
ALTER TABLE orders DROP COLUMN hold_actor_id;
ALTER TABLE orders DROP COLUMN hold_reason;
ALTER TABLE orders DROP COLUMN on_hold;
