-- Up Migration
CREATE TABLE order_admin_operations(reference text PRIMARY KEY,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
UPDATE invoice_sequences s SET last_no=GREATEST(s.last_no,COALESCE((SELECT max(d.seq_no) FROM invoice_documents d WHERE d.legal_entity_id=s.legal_entity_id AND d.financial_year=s.financial_year),0));
-- Down Migration
DROP TABLE order_admin_operations;
