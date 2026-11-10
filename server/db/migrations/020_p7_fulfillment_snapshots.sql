-- Up Migration
ALTER TABLE store_inventory ADD COLUMN bin_location text CHECK(length(bin_location) BETWEEN 1 AND 60);
ALTER TABLE order_items ADD COLUMN fulfillment_snapshot jsonb CHECK(fulfillment_snapshot IS NULL OR jsonb_typeof(fulfillment_snapshot)='object');
-- Down Migration
ALTER TABLE order_items DROP COLUMN fulfillment_snapshot;
ALTER TABLE store_inventory DROP COLUMN bin_location;
