-- Up Migration
-- P11 owns support, rating and payout records. Apply after P10 migration 026.
ALTER TABLE private_media DROP CONSTRAINT private_media_purpose_check;
ALTER TABLE private_media ADD CONSTRAINT private_media_purpose_check CHECK (purpose IN ('RIDER_KYC','DELIVERY_POD','SUPPORT_ATTACHMENT','PAYOUT_EVIDENCE'));
CREATE TABLE manual_refund_settlements (
 refund_id uuid PRIMARY KEY REFERENCES payment_refunds(id), actor_id uuid NOT NULL REFERENCES users(id),
 payment_reference text NOT NULL UNIQUE, evidence_media_id uuid NOT NULL REFERENCES private_media(id),
 idempotency_key text NOT NULL UNIQUE, request_hash text NOT NULL, settled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE support_tickets (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), order_id uuid REFERENCES orders(id),
 category text NOT NULL, status text NOT NULL CHECK(status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
 assignee_id uuid REFERENCES users(id), incident_key text UNIQUE, first_response_due_at timestamptz NOT NULL,
 resolution_due_at timestamptz NOT NULL, first_response_at timestamptz, resolved_at timestamptz,
 closed_at timestamptz, sla_cycle integer NOT NULL DEFAULT 1 CHECK(sla_cycle>0), version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX support_tickets_owner_idx ON support_tickets(owner_id,created_at DESC,id DESC);
CREATE INDEX support_tickets_sla_idx ON support_tickets(resolution_due_at) WHERE status IN ('OPEN','IN_PROGRESS');
CREATE TABLE support_ticket_messages (
 id uuid PRIMARY KEY, ticket_id uuid NOT NULL REFERENCES support_tickets(id), author_id uuid REFERENCES users(id),
 body text NOT NULL, internal boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX support_ticket_messages_ticket_idx ON support_ticket_messages(ticket_id,created_at,id);
CREATE TABLE support_ticket_attachments (
 ticket_id uuid NOT NULL REFERENCES support_tickets(id), message_id uuid REFERENCES support_ticket_messages(id),
 media_id uuid NOT NULL UNIQUE REFERENCES private_media(id), PRIMARY KEY(ticket_id,media_id)
);
CREATE UNIQUE INDEX p11_refund_approval_reference ON maker_checker_requests(action,maker_id,(payload->>'reference')) WHERE action IN ('supportRefund','ticketAdminRefund','payoutCorrection');
CREATE UNIQUE INDEX p11_payout_pending_approval ON maker_checker_requests(action,maker_id,(payload->>'id'),(payload->>'version')) WHERE action='payout' AND status='PENDING';
CREATE TABLE support_operations (actor_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL, reference text NOT NULL, request_hash text NOT NULL, result_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,operation,reference));
CREATE TABLE support_direct_refunds (reference text PRIMARY KEY, maker_id uuid NOT NULL REFERENCES users(id), amount_paise bigint NOT NULL CHECK (amount_paise > 0), request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX support_direct_refunds_daily ON support_direct_refunds(maker_id,created_at);
CREATE TABLE support_canned_responses (id uuid PRIMARY KEY, label text NOT NULL UNIQUE, body text NOT NULL, active boolean NOT NULL DEFAULT true, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE support_sla_alerts (ticket_id uuid NOT NULL REFERENCES support_tickets(id), cycle integer NOT NULL, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(ticket_id,cycle,kind));
CREATE TABLE ratings (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), rater_id uuid NOT NULL REFERENCES users(id),
 target_type text NOT NULL CHECK(target_type IN ('ORDER','RIDER','PRODUCT')), target_id uuid NOT NULL,
 stars smallint NOT NULL CHECK(stars BETWEEN 1 AND 5), comment text, hidden boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), edit_until timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(order_id,rater_id,target_type,target_id)
);
CREATE INDEX ratings_aggregate_idx ON ratings(target_type,target_id) WHERE NOT hidden;
CREATE TABLE payout_batches (id uuid PRIMARY KEY, cutoff timestamptz NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE rider_payouts (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES payout_batches(id), rider_id uuid NOT NULL REFERENCES users(id),
 state text NOT NULL CHECK(state IN ('DRAFT','APPROVED','PAID','SETTLED_ZERO','CANCELLED')),
 gross_paise bigint NOT NULL CHECK(gross_paise >= 0), cash_offset_paise bigint NOT NULL CHECK(cash_offset_paise >= 0),
 net_paise bigint NOT NULL CHECK(net_paise >= 0), version bigint NOT NULL DEFAULT 1,
 approval_id uuid, payment_reference text UNIQUE, evidence_media_id uuid REFERENCES private_media(id),
 payment_idempotency_key text UNIQUE, payment_request_hash text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approved_at timestamptz, paid_at timestamptz, CHECK(gross_paise = cash_offset_paise + net_paise)
);
CREATE UNIQUE INDEX one_live_payout_per_period ON rider_payouts(batch_id,rider_id) WHERE state <> 'CANCELLED';
CREATE UNIQUE INDEX one_live_draft_per_rider ON rider_payouts(rider_id) WHERE state='DRAFT';
CREATE TABLE payout_corrections (
 id uuid PRIMARY KEY, payout_id uuid NOT NULL REFERENCES rider_payouts(id), reference text NOT NULL UNIQUE,
 delta_paise bigint NOT NULL CHECK(delta_paise <> 0), reason text NOT NULL,
 state text NOT NULL CHECK(state IN ('CREDIT_PENDING','RECEIVABLE_OPEN','SETTLED')),
 maker_id uuid NOT NULL REFERENCES users(id), checker_id uuid NOT NULL REFERENCES users(id),
 payment_reference text UNIQUE, evidence_media_id uuid REFERENCES private_media(id), idempotency_key text UNIQUE, request_hash text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz
);
CREATE TABLE payout_earning_claims (payout_id uuid NOT NULL REFERENCES rider_payouts(id), earning_id uuid NOT NULL REFERENCES rider_earnings(id), active boolean NOT NULL DEFAULT true, PRIMARY KEY(payout_id,earning_id));
CREATE UNIQUE INDEX one_active_claim_per_earning ON payout_earning_claims(earning_id) WHERE active;
-- Down Migration
DROP TABLE payout_earning_claims;
DROP TABLE payout_corrections;
DROP TABLE rider_payouts;
DROP TABLE payout_batches;
DROP TABLE ratings;
DROP TABLE support_sla_alerts;
DROP TABLE support_canned_responses;
DROP TABLE support_direct_refunds;
DROP TABLE support_operations;
DROP INDEX p11_payout_pending_approval;
DROP INDEX p11_refund_approval_reference;
DROP TABLE support_ticket_attachments;
DROP TABLE support_ticket_messages;
DROP TABLE support_tickets;
DROP TABLE manual_refund_settlements;
ALTER TABLE private_media DROP CONSTRAINT private_media_purpose_check;
ALTER TABLE private_media ADD CONSTRAINT private_media_purpose_check CHECK (purpose IN ('RIDER_KYC','DELIVERY_POD')) NOT VALID;
