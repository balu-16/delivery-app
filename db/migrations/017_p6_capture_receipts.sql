-- Up Migration
-- Every distinct capture is money received, including an additional capture
-- for an already captured attempt. Receipts make that money refundable.
CREATE TABLE payment_capture_receipts (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  order_id uuid REFERENCES orders(id), gateway_payment_id text NOT NULL UNIQUE,
  amount_paise bigint NOT NULL CHECK(amount_paise>0), currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_capture_receipts_order_idx ON payment_capture_receipts(order_id);
INSERT INTO payment_capture_receipts(id,attempt_id,order_id,gateway_payment_id,amount_paise,currency)
 SELECT id,id,order_id,gateway_payment_id,amount_paise,currency FROM payment_attempts
 WHERE status='CAPTURED' AND gateway_payment_id IS NOT NULL;
-- Down Migration
DROP TABLE payment_capture_receipts;
