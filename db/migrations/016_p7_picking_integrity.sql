-- Up Migration
CREATE TABLE pick_item_batches (
 item_id uuid NOT NULL REFERENCES pick_items(id) ON DELETE CASCADE,
 batch_id uuid NOT NULL REFERENCES inventory_batches(id),
 quantity bigint NOT NULL CHECK (quantity > 0),
 PRIMARY KEY(item_id,batch_id)
);
INSERT INTO pick_item_batches(item_id,batch_id,quantity)
SELECT id,batch_id,picked_qty FROM pick_items WHERE batch_id IS NOT NULL AND picked_qty > 0;
-- Down Migration
DROP TABLE pick_item_batches;
