-- P6 owns wallet, orders, payments, refunds, COD financial records and invoices
-- (plan section 6.1 P6 row; D16/D17/D18/D19/D20). Money columns are bigint paise.
-- P4/P5 rows already hold generated order UUIDs without FKs; the deferred
-- constraints below are NOT VALID so every NEW row is enforced while existing
-- rows stay as-is. No placeholder order rows are invented. Rollback note:
-- development migrate:down drops the tables created here in reverse order;
-- production corrections use reviewed forward migrations only.
-- Up Migration
CREATE TABLE orders (
 id uuid PRIMARY KEY, order_number text NOT NULL UNIQUE CHECK (order_number ~ '^[A-Z0-9-]{6,40}$'),
 user_id uuid NOT NULL REFERENCES users(id), store_id uuid NOT NULL REFERENCES stores(id),
 address_snapshot jsonb NOT NULL, source text NOT NULL DEFAULT 'CUSTOMER' CHECK (source IN ('CUSTOMER','SUBSCRIPTION')),
 status text NOT NULL CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','PICKING','PACKED','OUT_FOR_DELIVERY','DELIVERED','PAYMENT_FAILED','EXPIRED','CANCELLED','DELIVERY_FAILED','RETURNED_TO_STORE')),
 payment_status text NOT NULL CHECK (payment_status IN ('UNPAID','PAID','PARTIALLY_REFUNDED','REFUNDED','COD_PENDING','COD_COLLECTED')),
 payment_method text CHECK (payment_method IN ('GATEWAY','WALLET','COD','ZERO_DUE')),
 currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
 subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0), discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
 fee_total_paise bigint NOT NULL DEFAULT 0 CHECK (fee_total_paise >= 0), tax_total_paise bigint NOT NULL DEFAULT 0 CHECK (tax_total_paise >= 0),
 tip_paise bigint NOT NULL DEFAULT 0 CHECK (tip_paise >= 0), total_paise bigint NOT NULL CHECK (total_paise >= 0),
 wallet_promo_paise bigint NOT NULL DEFAULT 0 CHECK (wallet_promo_paise >= 0), wallet_cash_paise bigint NOT NULL DEFAULT 0 CHECK (wallet_cash_paise >= 0),
 amount_due_paise bigint NOT NULL CHECK (amount_due_paise >= 0),
 delivery_slot jsonb, placed_at timestamptz NOT NULL, expires_at timestamptz, confirmed_at timestamptz,
 delivered_at timestamptz, cancelled_at timestamptz, cancel_reason text, cancelled_by uuid REFERENCES users(id),
 -- Coupon reservation id, breakdown snapshot and placement correlations live here.
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (total_paise = subtotal_paise - discount_paise + fee_total_paise + tip_paise),
 CHECK (amount_due_paise = total_paise - wallet_promo_paise - wallet_cash_paise)
);
CREATE INDEX orders_user_idx ON orders(user_id, placed_at DESC);
CREATE INDEX orders_store_status_idx ON orders(store_id, status, placed_at DESC);
CREATE INDEX orders_expiry_idx ON orders(expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE TABLE order_items (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, variant_id uuid NOT NULL REFERENCES catalog_variants(id),
 name_snapshot text NOT NULL, ordered_qty bigint NOT NULL CHECK (ordered_qty > 0), fulfilled_qty bigint NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),
 short_qty bigint NOT NULL DEFAULT 0 CHECK (short_qty >= 0), damaged_qty bigint NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
 unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0), mrp_paise bigint NOT NULL CHECK (mrp_paise >= 0),
 discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0), tax_paise bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
 tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 100000), hsn_code text NOT NULL,
 line_status text NOT NULL DEFAULT 'PENDING' CHECK (line_status IN ('PENDING','PARTIAL','FULFILLED','SHORT','DAMAGED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (fulfilled_qty + short_qty + damaged_qty <= ordered_qty)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE TABLE order_status_history (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 previous_state text, state text NOT NULL, action text NOT NULL, actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER','ADMIN','SYSTEM','RIDER','PICKER')),
 actor_id uuid REFERENCES users(id), reason text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_status_history_order_idx ON order_status_history(order_id, created_at);
CREATE FUNCTION reject_p6_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P6 financial history is append-only'; END $$;
CREATE TRIGGER order_status_history_immutable BEFORE UPDATE OR DELETE ON order_status_history FOR EACH ROW EXECUTE FUNCTION reject_p6_append_only_mutation();
CREATE TABLE order_adjustments (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('SHORT_REFUND','DAMAGED_REFUND','CANCELLATION_REFUND','GOODWILL','LATE_CAPTURE_REFUND','DUPLICATE_CAPTURE_REFUND','CORRECTION')),
 amount_paise bigint NOT NULL CHECK (amount_paise > 0), reason text NOT NULL, adjustment_reference text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (order_id, kind, adjustment_reference)
);
CREATE INDEX order_adjustments_order_idx ON order_adjustments(order_id, created_at);
CREATE TRIGGER order_adjustments_immutable BEFORE UPDATE OR DELETE ON order_adjustments FOR EACH ROW EXECUTE FUNCTION reject_p6_append_only_mutation();
CREATE TABLE order_code_verifiers (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
 verifier bytea NOT NULL, key_version integer NOT NULL CHECK (key_version > 0),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), locked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE wallet_accounts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id),
 cash_balance_paise bigint NOT NULL DEFAULT 0 CHECK (cash_balance_paise >= 0),
 promo_balance_paise bigint NOT NULL DEFAULT 0 CHECK (promo_balance_paise >= 0),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE wallet_promo_lots (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
 grant_reason text NOT NULL, source_reference text NOT NULL,
 amount_paise bigint NOT NULL CHECK (amount_paise > 0), remaining_paise bigint NOT NULL CHECK (remaining_paise >= 0),
 expires_at timestamptz, state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','EXHAUSTED','EXPIRED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (remaining_paise <= amount_paise), UNIQUE (account_id, grant_reason, source_reference)
);
CREATE INDEX wallet_promo_lots_fifo_idx ON wallet_promo_lots(account_id, created_at) WHERE state = 'ACTIVE' AND remaining_paise > 0;
-- Promo lots are consumed by amount and restored by wallet reversals, so the
-- remaining balance may move down (spend/expiry) or up (reversal) while the
-- identity fields stay immutable and the state tracks the remaining balance.
CREATE FUNCTION allow_promo_lot_remaining_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_paise <> OLD.amount_paise OR NEW.account_id <> OLD.account_id OR NEW.expires_at <> OLD.expires_at
     OR NEW.source_reference <> OLD.source_reference OR NEW.grant_reason <> OLD.grant_reason OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wallet promo lots are immutable apart from consumption/expiry';
  END IF;
  IF OLD.state = 'EXPIRED' AND (NEW.state <> 'EXPIRED' OR NEW.remaining_paise <> OLD.remaining_paise) THEN
    RAISE EXCEPTION 'expired promo lots are terminal';
  END IF;
  IF (NEW.remaining_paise > 0 AND NEW.state = 'EXHAUSTED') OR (NEW.remaining_paise = 0 AND NEW.state = 'ACTIVE') THEN
    RAISE EXCEPTION 'promo lot state must match its remaining balance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_promo_lots_immutable BEFORE UPDATE OR DELETE ON wallet_promo_lots FOR EACH ROW EXECUTE FUNCTION allow_promo_lot_remaining_update();
CREATE TABLE wallet_ledger (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
 bucket text NOT NULL CHECK (bucket IN ('cash','promo')), delta_paise bigint NOT NULL,
 reason text NOT NULL CHECK (reason IN ('ORDER_PAYMENT','ORDER_PAYMENT_REVERSAL','TOPUP_CREDIT','PROMO_GRANT','PROMO_EXPIRY','REFUND_CREDIT','ADMIN_ADJUSTMENT')),
 ref_type text NOT NULL, ref_id text NOT NULL,
 lot_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
 balance_after bigint NOT NULL CHECK (balance_after >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (account_id, bucket, ref_type, ref_id, reason)
);
CREATE INDEX wallet_ledger_account_created_idx ON wallet_ledger(account_id, created_at DESC, id);
CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION reject_p6_append_only_mutation();
CREATE TABLE payment_attempts (
 id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('ORDER_PAYMENT','WALLET_TOPUP')),
 order_id uuid REFERENCES orders(id), user_id uuid REFERENCES users(id),
 operation_reference text NOT NULL UNIQUE CHECK (operation_reference ~ '^[a-z][a-z0-9-]{9,39}$'),
 gateway text NOT NULL CHECK (gateway IN ('fake','razorpay')),
 gateway_order_id text UNIQUE, gateway_payment_id text UNIQUE,
 amount_paise bigint NOT NULL CHECK (amount_paise > 0), currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','AUTHORIZED','CAPTURED','FAILED','UNKNOWN')),
 failure_code text, captured_at timestamptz, external_attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_attempts_order_idx ON payment_attempts(order_id);
CREATE INDEX payment_attempts_aggregate_idx ON payment_attempts(aggregate_id, kind);
CREATE TABLE wallet_funding_allocations (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
 attempt_id uuid REFERENCES payment_attempts(id), wallet_spend_reference text,
 promo_paise bigint NOT NULL DEFAULT 0 CHECK (promo_paise >= 0), cash_paise bigint NOT NULL DEFAULT 0 CHECK (cash_paise >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE gateway_event_inbox (
 id uuid PRIMARY KEY, gateway text NOT NULL CHECK (gateway IN ('fake','razorpay')),
 gateway_event_id text NOT NULL, event_type text,
 body text NOT NULL, body_hash text NOT NULL, signature text NOT NULL, signature_valid boolean NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','PROCESSED','QUARANTINED')),
 quarantine_reason text CHECK (quarantine_reason IN ('SIGNATURE_INVALID','CHANGED_BODY','AMOUNT_MISMATCH','CURRENCY_MISMATCH','UNMAPPED_EVENT','UNPARSEABLE')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (gateway, gateway_event_id)
);
CREATE INDEX gateway_event_inbox_due_idx ON gateway_event_inbox(next_attempt_at) WHERE state IN ('PENDING','PROCESSING');
CREATE TABLE payment_refunds (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 refund_reference text NOT NULL UNIQUE CHECK (refund_reference ~ '^[a-z][a-z0-9-]{9,39}$'),
 source_type text NOT NULL CHECK (source_type IN ('GATEWAY_CAPTURE','WALLET_DEBIT','COD_COLLECTION')),
 source_id text NOT NULL, attempt_id uuid REFERENCES payment_attempts(id),
 amount_paise bigint NOT NULL CHECK (amount_paise > 0),
 destination text NOT NULL CHECK (destination IN ('GATEWAY','WALLET','MANUAL_PAYOUT')),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSED','FAILED','UNKNOWN')),
 gateway_refund_id text UNIQUE, reason text, initiated_by uuid REFERENCES users(id),
 external_attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_refunds_order_idx ON payment_refunds(order_id);
CREATE INDEX payment_refunds_source_idx ON payment_refunds(source_type, source_id, status);
CREATE TABLE refund_allocations (
 id uuid PRIMARY KEY, refund_id uuid NOT NULL UNIQUE REFERENCES payment_refunds(id) ON DELETE CASCADE,
 source_type text NOT NULL CHECK (source_type IN ('GATEWAY_CAPTURE','WALLET_DEBIT','COD_COLLECTION')),
 source_id text NOT NULL, amount_paise bigint NOT NULL CHECK (amount_paise > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (source_type, source_id, refund_id)
);
CREATE TABLE reconciliation_findings (
 id uuid PRIMARY KEY, kind text NOT NULL, severity text NOT NULL CHECK (severity IN ('WARN','CRITICAL')),
 aggregate_type text NOT NULL, aggregate_id text NOT NULL, reference text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
 resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reconciliation_findings_open_idx ON reconciliation_findings(status, severity, created_at DESC);
CREATE UNIQUE INDEX reconciliation_findings_dedupe_idx ON reconciliation_findings(kind, reference) WHERE status = 'OPEN';
CREATE TABLE fraud_signals (
 id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), kind text NOT NULL,
 severity text NOT NULL CHECK (severity IN ('WARN','CRITICAL')), reference text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz
);
CREATE INDEX fraud_signals_open_idx ON fraud_signals(status, severity, created_at DESC);
CREATE TABLE cod_collections (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
 amount_paise bigint NOT NULL CHECK (amount_paise > 0), currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
 state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','COLLECTED')),
 collected_at timestamptz, collected_by uuid REFERENCES users(id), version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE invoice_sequences (
 legal_entity_id uuid NOT NULL REFERENCES legal_entities(id), financial_year text NOT NULL CHECK (financial_year ~ '^\d{4}-\d{2}$'),
 last_no bigint NOT NULL DEFAULT 0 CHECK (last_no >= 0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (legal_entity_id, financial_year)
);
CREATE TABLE invoice_documents (
 id uuid PRIMARY KEY, legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('INVOICE','CREDIT_NOTE')),
 financial_year text NOT NULL CHECK (financial_year ~ '^\d{4}-\d{2}$'), seq_no bigint NOT NULL CHECK (seq_no > 0),
 number text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED')),
 payload jsonb NOT NULL, renderer_state text NOT NULL DEFAULT 'PENDING' CHECK (renderer_state IN ('PENDING','RENDERED','FAILED')),
 rendered_at timestamptz, issued_at timestamptz, credit_note_for uuid REFERENCES invoice_documents(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (legal_entity_id, financial_year, seq_no)
);
CREATE INDEX invoice_documents_order_idx ON invoice_documents(order_id, kind);
-- D19: the document payload, number and sequence are immutable, but issuance
-- (DRAFT -> ISSUED) and rendering retries (PENDING -> RENDERED/FAILED) must be
-- able to record their progress on the same committed number.
CREATE FUNCTION allow_invoice_lifecycle_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'invoice documents are append-only';
  END IF;
  IF NEW.legal_entity_id <> OLD.legal_entity_id OR NEW.order_id <> OLD.order_id OR NEW.kind <> OLD.kind
     OR NEW.financial_year <> OLD.financial_year OR NEW.seq_no <> OLD.seq_no OR NEW.number <> OLD.number
     OR NEW.payload <> OLD.payload OR NEW.credit_note_for IS DISTINCT FROM OLD.credit_note_for THEN
    RAISE EXCEPTION 'issued invoice documents are immutable';
  END IF;
  IF OLD.status = 'ISSUED' AND NEW.status <> 'ISSUED' THEN
    RAISE EXCEPTION 'issued invoices cannot regress to draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_documents_immutable BEFORE UPDATE OR DELETE ON invoice_documents FOR EACH ROW EXECUTE FUNCTION allow_invoice_lifecycle_update();
-- Deferred references (plan 6.1): P4/P5 rows predate the orders table and hold
-- generated UUIDs. NOT VALID still enforces every new row; nothing is disabled.
ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) NOT VALID;
ALTER TABLE inventory_shortfall_obligations
  ADD CONSTRAINT inventory_shortfall_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) NOT VALID;
ALTER TABLE coupon_redemptions
  ADD CONSTRAINT coupon_redemptions_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) NOT VALID;
-- Additive expand columns P6 needs (Section 14/16 data model): per-store COD
-- acceptance gates checkout COD eligibility; the legal-entity tax identity
-- feeds invoice payloads (NULL until the owner populates registration data).
ALTER TABLE stores ADD COLUMN accepts_cod boolean NOT NULL DEFAULT false;
ALTER TABLE legal_entities
  ADD COLUMN gstin text,
  ADD COLUMN fssai_no text,
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV';
-- Down Migration
ALTER TABLE legal_entities DROP COLUMN invoice_prefix;
ALTER TABLE legal_entities DROP COLUMN fssai_no;
ALTER TABLE legal_entities DROP COLUMN gstin;
ALTER TABLE stores DROP COLUMN accepts_cod;
ALTER TABLE coupon_redemptions DROP CONSTRAINT coupon_redemptions_order_fk;
ALTER TABLE inventory_shortfall_obligations DROP CONSTRAINT inventory_shortfall_order_fk;
ALTER TABLE inventory_reservations DROP CONSTRAINT inventory_reservations_order_fk;
DROP TRIGGER invoice_documents_immutable ON invoice_documents;
DROP FUNCTION allow_invoice_lifecycle_update();
DROP TABLE invoice_documents;
DROP TABLE invoice_sequences;
DROP TABLE cod_collections;
DROP TABLE fraud_signals;
DROP TABLE reconciliation_findings;
DROP TABLE refund_allocations;
DROP TABLE payment_refunds;
DROP TABLE gateway_event_inbox;
DROP TABLE wallet_funding_allocations;
DROP TABLE payment_attempts;
DROP TRIGGER wallet_ledger_immutable ON wallet_ledger;
DROP TABLE wallet_ledger;
DROP TRIGGER wallet_promo_lots_immutable ON wallet_promo_lots;
DROP FUNCTION allow_promo_lot_remaining_update();
DROP TABLE wallet_promo_lots;
DROP TABLE wallet_accounts;
DROP TABLE order_code_verifiers;
DROP TRIGGER order_adjustments_immutable ON order_adjustments;
DROP TABLE order_adjustments;
DROP TRIGGER order_status_history_immutable ON order_status_history;
DROP TABLE order_status_history;
DROP TABLE order_items;
DROP TABLE orders;
DROP FUNCTION reject_p6_append_only_mutation();
