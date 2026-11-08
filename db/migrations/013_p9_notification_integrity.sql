-- Up Migration
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_status_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check CHECK (status IN ('PENDING','CLAIMED','SENT','FAILED','HELD'));
ALTER TABLE notification_deliveries ADD COLUMN lease_token uuid, ADD COLUMN lease_until timestamptz, ADD COLUMN ambiguous_sends integer NOT NULL DEFAULT 0;
CREATE INDEX notification_deliveries_claimed_idx ON notification_deliveries(lease_until) WHERE status='CLAIMED';
CREATE TABLE notification_token_results (
 delivery_id uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
 token_id uuid NOT NULL REFERENCES device_tokens(id),
 status text NOT NULL CHECK (status IN ('SENT','INVALID','RETRY','FAILED')),
 provider_message_id text, error text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(delivery_id,token_id)
);
CREATE TABLE notification_event_errors (
 event_id uuid PRIMARY KEY, event_type text NOT NULL, aggregate_id text NOT NULL,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO notification_templates(template_key,locale,channel,subject,body) VALUES
 ('store.new_order','en','PUSH','New order','Order {{orderNumber}} is ready for fulfillment.'),
 ('store.new_order','en','INBOX','New order','Order {{orderNumber}} is ready for fulfillment.')
ON CONFLICT DO NOTHING;
INSERT INTO notification_templates(template_key,locale,channel,subject,body)
SELECT t.template_key,'en',c.channel,t.subject,t.body FROM (VALUES
 ('refund.initiated','Refund initiated','Your refund is being processed.'),
 ('wallet.low_balance','Wallet balance low','Your wallet balance may be insufficient for an upcoming order.'),
 ('subscription.reminder','Upcoming subscription','Your subscription delivery is coming up.'),
 ('subscription.skipped','Subscription skipped','A subscription delivery was skipped.'),
 ('admin.operational_alert','Operational alert','An operational event requires review: {{kind}}.')
) AS t(template_key,subject,body) CROSS JOIN (VALUES ('PUSH'),('INBOX')) AS c(channel)
ON CONFLICT DO NOTHING;
UPDATE notification_templates SET body='Failed notifications: {{failed}}; suspended events: {{suspended}}; invalid event contracts: {{eventErrors}}.' WHERE template_key='admin.dlq_growth' AND locale='en' AND channel='INBOX';
