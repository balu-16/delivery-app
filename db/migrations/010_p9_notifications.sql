-- P9 notifications: templates, device tokens, preferences, inbox entries,
-- per-channel delivery attempts and dedupe (plan section 6.1 P9 row; ADR 0011).
-- Recipient data and deep links only in payloads; no delivery codes, no PII.
-- Rollback note: development migrate:down drops the tables created here in
-- reverse order; production corrections use reviewed forward migrations only.
-- Up Migration
CREATE TABLE notification_templates (
 template_key text NOT NULL CHECK (template_key ~ '^[a-z0-9_.]{1,80}$'),
 locale text NOT NULL CHECK (locale IN ('en','hi','te')),
 channel text NOT NULL CHECK (channel IN ('PUSH','EMAIL','INBOX')),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 PRIMARY KEY (template_key, locale, channel)
);
CREATE TABLE device_tokens (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 token text NOT NULL UNIQUE CHECK (length(token) BETWEEN 16 AND 4096),
 platform text NOT NULL CHECK (platform IN ('ANDROID','IOS','WEB')),
 app text NOT NULL CHECK (app IN ('CUSTOMER','RIDER','STORE','ADMIN')),
 active boolean NOT NULL DEFAULT true,
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Registration is by token: the same token moving to another user on login is
-- reassigned (UPDATE below keeps one row per token).
CREATE INDEX device_tokens_recipient_idx ON device_tokens(user_id, app, active, last_seen_at DESC);
CREATE TABLE notification_preferences (
 user_id uuid NOT NULL REFERENCES users(id),
 category text NOT NULL CHECK (category IN
  ('ORDER_UPDATES','PAYMENTS','WALLET','RIDING','STORE_OPS','ADMIN','PROMOTIONS')),
 enabled boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (user_id, category)
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 channel text NOT NULL CHECK (channel IN ('PUSH','EMAIL','INBOX')),
 template_key text NOT NULL,
 locale text NOT NULL CHECK (locale IN ('en','hi','te')),
 category text NOT NULL CHECK (category IN
  ('ORDER_UPDATES','PAYMENTS','WALLET','RIDING','STORE_OPS','ADMIN','PROMOTIONS')),
 class text NOT NULL CHECK (class IN ('TRANSACTIONAL','PROMOTIONAL')),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED','QUIET_HELD')),
 -- recipient|channel|eventType|aggregateId|aggregateVersion: replayed events
 -- insert one logical row; a distinct transition version notifies again.
 dedupe_key text NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 512),
 read_at timestamptz,
 error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sent_at timestamptz
);
-- Inbox keyset pagination: (user_id, created_at DESC, id DESC).
CREATE INDEX notifications_inbox_idx ON notifications(user_id, created_at DESC, id DESC);
-- Unread badge count.
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE TABLE notification_deliveries (
 id uuid PRIMARY KEY,
 notification_id uuid NOT NULL UNIQUE REFERENCES notifications(id) ON DELETE CASCADE,
 channel text NOT NULL CHECK (channel IN ('PUSH','EMAIL','INBOX')),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','HELD')),
 provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 512),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 last_error text,
 next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Recovery scan: due (or lost) sends are re-enqueued by delivery id, so the
-- durable row rebuilds lost Redis work after queue data loss.
CREATE INDEX notification_deliveries_due_idx
 ON notification_deliveries(next_retry_at, id) WHERE status = 'PENDING';
CREATE INDEX notification_deliveries_held_idx
 ON notification_deliveries(next_retry_at, id) WHERE status = 'HELD';

-- Seeded templates: customer-facing keys in en/hi/te, operational keys in en
-- (locale fallback en renders them for every user). PUSH/INBOX share the
-- subject as the title; EMAIL rows carry an email subject and body.
INSERT INTO notification_templates(template_key, locale, channel, subject, body) VALUES
 ('order.confirmed','en','PUSH','Order confirmed','Your order {{orderNumber}} is confirmed.'),
 ('order.confirmed','en','INBOX','Order confirmed','Your order {{orderNumber}} is confirmed.'),
 ('order.confirmed','en','EMAIL','Order {{orderNumber}} confirmed','Your order {{orderNumber}} is confirmed. Track it in the app.'),
 ('order.confirmed','hi','PUSH','ऑर्डर की पुष्टि','आपका ऑर्डर {{orderNumber}} की पुष्टि हो गई है।'),
 ('order.confirmed','hi','INBOX','ऑर्डर की पुष्टि','आपका ऑर्डर {{orderNumber}} की पुष्टि हो गई है।'),
 ('order.confirmed','te','PUSH','ఆర్డర్ ఖరారు','మీ ఆర్డర్ {{orderNumber}} ఖరారైంది.'),
 ('order.confirmed','te','INBOX','ఆర్డర్ ఖరారు','మీ ఆర్డర్ {{orderNumber}} ఖరారైంది.'),
 ('order.picking','en','PUSH','Order being picked','Your order {{orderNumber}} is being picked.'),
 ('order.picking','en','INBOX','Order being picked','Your order {{orderNumber}} is being picked.'),
 ('order.picking','hi','PUSH','ऑर्डर तैयार हो रहा है','आपका ऑर्डर {{orderNumber}} तैयार किया जा रहा है।'),
 ('order.picking','hi','INBOX','ऑर्डर तैयार हो रहा है','आपका ऑर्डर {{orderNumber}} तैयार किया जा रहा है।'),
 ('order.picking','te','PUSH','ఆర్డర్ పిక్ అవుతోంది','మీ ఆర్డర్ {{orderNumber}} పిక్ చేయబడుతోంది.'),
 ('order.picking','te','INBOX','ఆర్డర్ పిక్ అవుతోంది','మీ ఆర్డర్ {{orderNumber}} పిక్ చేయబడుతోంది.'),
 ('order.packed','en','PUSH','Order packed','Your order {{orderNumber}} is packed and ready.'),
 ('order.packed','en','INBOX','Order packed','Your order {{orderNumber}} is packed and ready.'),
 ('order.packed','en','EMAIL','Order {{orderNumber}} packed','Your order {{orderNumber}} is packed and ready for handover.'),
 ('order.packed','hi','PUSH','ऑर्डर पैक हो गया','आपका ऑर्डर {{orderNumber}} पैक हो गया है।'),
 ('order.packed','hi','INBOX','ऑर्डर पैक हो गया','आपका ऑर्डर {{orderNumber}} पैक हो गया है।'),
 ('order.packed','te','PUSH','ఆర్డర్ ప్యాక్ అయింది','మీ ఆర్డర్ {{orderNumber}} ప్యాక్ చేయబడింది.'),
 ('order.packed','te','INBOX','ఆర్డర్ ప్యాక్ అయింది','మీ ఆర్డర్ {{orderNumber}} ప్యాక్ చేయబడింది.'),
 ('order.out_for_delivery','en','PUSH','Out for delivery','Your order {{orderNumber}} is out for delivery.'),
 ('order.out_for_delivery','en','INBOX','Out for delivery','Your order {{orderNumber}} is out for delivery.'),
 ('order.out_for_delivery','hi','PUSH','डिलीवरी के लिए निकला','आपका ऑर्डर {{orderNumber}} डिलीवरी के लिए निकल गया है।'),
 ('order.out_for_delivery','hi','INBOX','डिलीवरी के लिए निकला','आपका ऑर्डर {{orderNumber}} डिलीवरी के लिए निकल गया है।'),
 ('order.out_for_delivery','te','PUSH','డెలివరీకి బయలుదేరింది','మీ ఆర్డర్ {{orderNumber}} డెలివరీకి బయలుదేరింది.'),
 ('order.out_for_delivery','te','INBOX','డెలివరీకి బయలుదేరింది','మీ ఆర్డర్ {{orderNumber}} డెలివరీకి బయలుదేరింది.'),
 ('order.delivered','en','PUSH','Order delivered','Your order {{orderNumber}} was delivered.'),
 ('order.delivered','en','INBOX','Order delivered','Your order {{orderNumber}} was delivered.'),
 ('order.delivered','en','EMAIL','Order {{orderNumber}} delivered','Your order {{orderNumber}} was delivered. Rate your experience in the app.'),
 ('order.delivered','hi','PUSH','ऑर्डर डिलीवर हो गया','आपका ऑर्डर {{orderNumber}} डिलीवर हो गया है।'),
 ('order.delivered','hi','INBOX','ऑर्डर डिलीवर हो गया','आपका ऑर्डर {{orderNumber}} डिलीवर हो गया है।'),
 ('order.delivered','te','PUSH','ఆర్డర్ డెలివర్ అయింది','మీ ఆర్డర్ {{orderNumber}} డెలివర్ చేయబడింది.'),
 ('order.delivered','te','INBOX','ఆర్డర్ డెలివర్ అయింది','మీ ఆర్డర్ {{orderNumber}} డెలివర్ చేయబడింది.'),
 ('order.cancelled','en','PUSH','Order cancelled','Your order {{orderNumber}} was cancelled. Refunds, if any, are processed to the original payment method.'),
 ('order.cancelled','en','INBOX','Order cancelled','Your order {{orderNumber}} was cancelled.'),
 ('order.cancelled','en','EMAIL','Order {{orderNumber}} cancelled','Your order {{orderNumber}} was cancelled. Refunds, if any, go to the original payment method.'),
 ('order.cancelled','hi','PUSH','ऑर्डर रद्द','आपका ऑर्डर {{orderNumber}} रद्द कर दिया गया है।'),
 ('order.cancelled','hi','INBOX','ऑर्डर रद्द','आपका ऑर्डर {{orderNumber}} रद्द कर दिया गया है।'),
 ('order.cancelled','te','PUSH','ఆర్డర్ రద్దు','మీ ఆర్డర్ {{orderNumber}} రద్దు చేయబడింది.'),
 ('order.cancelled','te','INBOX','ఆర్డర్ రద్దు','మీ ఆర్డర్ {{orderNumber}} రద్దు చేయబడింది.'),
 ('order.delivery_failed','en','PUSH','Delivery attempt failed','We could not deliver order {{orderNumber}}. Our team will contact you.'),
 ('order.delivery_failed','en','INBOX','Delivery attempt failed','We could not deliver order {{orderNumber}}.'),
 ('order.delivery_failed','hi','PUSH','डिलीवरी असफल','ऑर्डर {{orderNumber}} डिलीवर नहीं हो सका। हमारी टीम संपर्क करेगी।'),
 ('order.delivery_failed','hi','INBOX','डिलीवरी असफल','ऑर्डर {{orderNumber}} डिलीवर नहीं हो सका।'),
 ('order.delivery_failed','te','PUSH','డెలివరీ విఫలమైంది','ఆర్డర్ {{orderNumber}} డెలివర్ చేయబడలేదు. మా టీమ్ సంప్రదిస్తుంది.'),
 ('order.delivery_failed','te','INBOX','డెలివరీ విఫలమైంది','ఆర్డర్ {{orderNumber}} డెలివర్ చేయబడలేదు.'),
 ('item.short','en','PUSH','Item unavailable','An item in order {{orderNumber}} was unavailable. {{detail}}'),
 ('item.short','en','INBOX','Item unavailable','An item in order {{orderNumber}} was unavailable. {{detail}}'),
 ('item.substituted','en','PUSH','Item substituted','An item in order {{orderNumber}} was substituted. {{detail}}'),
 ('item.substituted','en','INBOX','Item substituted','An item in order {{orderNumber}} was substituted. {{detail}}'),
 ('payment.failed','en','PUSH','Payment failed','Your payment for order {{orderNumber}} failed. Please retry from the app.'),
 ('payment.failed','en','INBOX','Payment failed','Your payment for order {{orderNumber}} failed.'),
 ('payment.failed','en','EMAIL','Payment for order {{orderNumber}} failed','Your payment for order {{orderNumber}} failed. Please retry from the app.'),
 ('payment.failed','hi','PUSH','भुगतान असफल','ऑर्डर {{orderNumber}} का भुगतान असफल हुआ। कृपया ऐप से पुनः प्रयास करें।'),
 ('payment.failed','hi','INBOX','भुगतान असफल','ऑर्डर {{orderNumber}} का भुगतान असफल हुआ।'),
 ('payment.failed','te','PUSH','చెల్లింపు విఫలమైంది','ఆర్డర్ {{orderNumber}} చెల్లింపు విఫలమైంది. దయచేసి యాప్ నుండి మళ్లీ ప్రయత్నించండి.'),
 ('payment.failed','te','INBOX','చెల్లింపు విఫలమైంది','ఆర్డర్ {{orderNumber}} చెల్లింపు విఫలమైంది.'),
 ('refund.processed','en','PUSH','Refund processed','A refund of {{amount}} for order {{orderNumber}} has been processed.'),
 ('refund.processed','en','INBOX','Refund processed','A refund of {{amount}} for order {{orderNumber}} has been processed.'),
 ('refund.processed','en','EMAIL','Refund for order {{orderNumber}} processed','A refund of {{amount}} for order {{orderNumber}} has been processed to your original payment method.'),
 ('refund.processed','hi','PUSH','रिफंड प्रोसेस हुआ','ऑर्डर {{orderNumber}} का {{amount}} का रिफंड प्रोसेस हो गया है।'),
 ('refund.processed','hi','INBOX','रिफंड प्रोसेस हुआ','ऑर्डर {{orderNumber}} का {{amount}} का रिफंड प्रोसेस हो गया है।'),
 ('refund.processed','te','PUSH','రీఫండ్ ప్రాసెస్ అయింది','ఆర్డర్ {{orderNumber}} కు {{amount}} రీఫండ్ ప్రాసెస్ చేయబడింది.'),
 ('refund.processed','te','INBOX','రీఫండ్ ప్రాసెస్ అయింది','ఆర్డర్ {{orderNumber}} కు {{amount}} రీఫండ్ ప్రాసెస్ చేయబడింది.'),
 ('wallet.topup','en','PUSH','Wallet added','{{amount}} was added to your wallet.'),
 ('wallet.topup','en','INBOX','Wallet added','{{amount}} was added to your wallet.'),
 ('wallet.topup','hi','PUSH','वॉलेट में जोड़ा गया','आपके वॉलेट में {{amount}} जोड़ा गया।'),
 ('wallet.topup','hi','INBOX','वॉलेट में जोड़ा गया','आपके वॉलेट में {{amount}} जोड़ा गया।'),
 ('wallet.topup','te','PUSH','వాలెట్‌లో జోడించబడింది','మీ వాలెట్‌లో {{amount}} జోడించబడింది.'),
 ('wallet.topup','te','INBOX','వాలెట్‌లో జోడించబడింది','మీ వాలెట్‌లో {{amount}} జోడించబడింది.'),
 ('store.low_stock','en','PUSH','Low stock','Variant {{variantId}} at your store is low ({{available}} left).'),
 ('store.low_stock','en','INBOX','Low stock','Variant {{variantId}} at your store is low ({{available}} left).'),
 ('store.expiring_batch','en','PUSH','Batch expiring','Batch {{batchId}} for variant {{variantId}} expires soon.'),
 ('store.expiring_batch','en','INBOX','Batch expiring','Batch {{batchId}} for variant {{variantId}} expires soon.'),
 ('store.sla_breached','en','PUSH','Pick SLA breached','Pick task for order {{orderId}} breached its SLA.'),
 ('store.sla_breached','en','INBOX','Pick SLA breached','Pick task for order {{orderId}} breached its SLA.'),
 ('rider.offer','en','PUSH','New delivery offer','A new delivery offer is available. Open the app to accept.'),
 ('rider.offer','en','INBOX','New delivery offer','A new delivery offer is available.'),
 ('rider.offer_revoked','en','PUSH','Offer expired','The delivery offer is no longer available.'),
 ('rider.offer_revoked','en','INBOX','Offer expired','The delivery offer is no longer available.'),
 ('rider.document.approved','en','PUSH','Document approved','Your document was approved. You can go online.'),
 ('rider.document.approved','en','INBOX','Document approved','Your document was approved.'),
 ('rider.document.rejected','en','PUSH','Document rejected','Your document was rejected: {{reason}}'),
 ('rider.document.rejected','en','INBOX','Document rejected','Your document was rejected: {{reason}}'),
 ('admin.no_riders','en','PUSH','No riders available','No riders are available for order {{orderId}}. Dispatch is widening the radius.'),
 ('admin.no_riders','en','INBOX','No riders available','No riders are available for order {{orderId}}.'),
 ('admin.reconciliation','en','PUSH','Reconciliation finding','Reconciliation finding {{kind}} on {{aggregateType}} {{aggregateId}}.'),
 ('admin.reconciliation','en','INBOX','Reconciliation finding','Reconciliation finding {{kind}} on {{aggregateType}} {{aggregateId}}.'),
 ('admin.dlq_growth','en','PUSH','Failed jobs growing','Failed jobs detected: {{failed}} dead letters and {{suspended}} suspended deliveries.'),
 ('admin.dlq_growth','en','INBOX','Failed jobs growing','Failed jobs detected: {{failed}} dead letters and {{suspended}} suspended deliveries.'),
 ('promotions.offer','en','PUSH','Weekend offer','{{detail}} — only this weekend.'),
 ('promotions.offer','en','INBOX','Weekend offer','{{detail}} — only this weekend.'),
 ('promotions.offer','hi','INBOX','सप्ताहांत ऑफर','{{detail}} — केवल इस सप्ताहांत।'),
 ('promotions.offer','te','INBOX','వీకెండ్ ఆఫర్','{{detail}} — ఈ వీకెండ్ మాత్రమే.');

-- Down Migration
DROP TABLE notification_deliveries;
DROP TABLE notifications;
DROP TABLE notification_preferences;
DROP TABLE device_tokens;
DROP TABLE notification_templates;
