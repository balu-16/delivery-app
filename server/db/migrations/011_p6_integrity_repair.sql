-- Up Migration
-- P6 integrity: reject previously persisted invalid webhooks and enforce one
-- order per consumed checkout intent across all idempotency keys.
UPDATE gateway_event_inbox SET state='QUARANTINED', quarantine_reason='SIGNATURE_INVALID'
 WHERE NOT signature_valid AND state IN ('PENDING','PROCESSING');
CREATE UNIQUE INDEX orders_checkout_intent_unique_idx ON orders ((metadata->>'intentId'))
 WHERE metadata ? 'intentId';
ALTER TABLE cod_collections DROP CONSTRAINT cod_collections_amount_paise_check;
ALTER TABLE cod_collections ADD CONSTRAINT cod_collections_amount_paise_check CHECK (amount_paise >= 0);
CREATE TABLE wallet_reversal_allocations (
  spend_reference text NOT NULL, reversal_reference text NOT NULL, bucket text NOT NULL CHECK (bucket IN ('cash','promo')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), lot_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (spend_reference, reversal_reference, bucket)
);
-- Down Migration
DROP TABLE wallet_reversal_allocations;
ALTER TABLE cod_collections DROP CONSTRAINT cod_collections_amount_paise_check;
ALTER TABLE cod_collections ADD CONSTRAINT cod_collections_amount_paise_check CHECK (amount_paise > 0);
DROP INDEX orders_checkout_intent_unique_idx;
