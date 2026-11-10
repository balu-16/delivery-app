-- Up Migration
-- Expected cash survives a rider recording a different actual collection.
ALTER TABLE cod_collections ADD COLUMN expected_amount_paise bigint CHECK(expected_amount_paise>=0);
UPDATE cod_collections c SET expected_amount_paise=o.amount_due_paise FROM orders o WHERE o.id=c.order_id;
-- Down Migration
ALTER TABLE cod_collections DROP COLUMN expected_amount_paise;
