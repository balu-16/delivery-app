-- Up Migration
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY, variant_id uuid NOT NULL REFERENCES catalog_variants(id),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (variant_id)
);
CREATE TABLE subscription_slots (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), name text NOT NULL,
  start_time time NOT NULL, end_time time NOT NULL, active boolean NOT NULL DEFAULT true,
  CHECK (start_time < end_time), UNIQUE (store_id, name)
);
CREATE TABLE subscription_holidays (
  store_id uuid NOT NULL REFERENCES stores(id), holiday_date date NOT NULL, reason text,
  PRIMARY KEY (store_id, holiday_date)
);
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id), store_id uuid NOT NULL REFERENCES stores(id),
  address_id uuid NOT NULL REFERENCES addresses(id), start_date date NOT NULL, end_date date,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELLED','COMPLETED')),
  failure_streak integer NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
  next_delivery_date date, generation_claim_token uuid, generation_claim_until timestamptz, forecast_checked_at timestamptz, last_unit_price_paise bigint CHECK (last_unit_price_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX subscriptions_user_status_idx ON subscriptions(user_id,status);
CREATE INDEX subscriptions_due_idx ON subscriptions(store_id,next_delivery_date,id) WHERE status='ACTIVE';
CREATE TABLE subscription_schedule_versions (
  id uuid PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES subscriptions(id), effective_from date NOT NULL,
  quantity bigint NOT NULL CHECK(quantity > 0), frequency_rule jsonb NOT NULL,
  slot_id uuid NOT NULL REFERENCES subscription_slots(id), address_id uuid REFERENCES addresses(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(subscription_id,effective_from)
);
CREATE TABLE subscription_skips (
  subscription_id uuid NOT NULL REFERENCES subscriptions(id), delivery_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(subscription_id,delivery_date)
);
CREATE TABLE subscription_pauses (
  id uuid PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  starts_on date NOT NULL, ends_on date NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(starts_on <= ends_on)
);
CREATE INDEX subscription_pauses_dates_idx ON subscription_pauses(subscription_id,starts_on,ends_on);
CREATE TABLE subscription_generation_runs (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), delivery_date date NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','COMPLETE','INCOMPLETE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(store_id,delivery_date)
);
CREATE TABLE subscription_occurrences (
  id uuid PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES subscriptions(id), delivery_date date NOT NULL,
  run_id uuid REFERENCES subscription_generation_runs(id), order_id uuid UNIQUE REFERENCES orders(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRYABLE','ORDERED','SKIPPED')),
  reason text, fulfillment_outcome text CHECK(fulfillment_outcome IN ('SKIPPED_OOS','CANCELLED','DELIVERED')),
  retry_at timestamptz, retry_deadline timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(subscription_id,delivery_date),
  CHECK ((state='ORDERED') = (order_id IS NOT NULL)),
  CHECK (state <> 'RETRYABLE' OR (retry_at IS NOT NULL AND retry_deadline IS NOT NULL))
);
CREATE INDEX subscription_occurrences_retry_idx ON subscription_occurrences(retry_at,id) WHERE state='RETRYABLE';
CREATE TABLE subscription_alerts (
  id uuid PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES subscriptions(id), delivery_date date NOT NULL,
  kind text NOT NULL CHECK(kind IN ('LOW_BALANCE','PRICE_INCREASE')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(subscription_id,delivery_date,kind)
);
INSERT INTO notification_templates(template_key,locale,channel,subject,body)
SELECT t.key,'en',c.channel,t.subject,t.body FROM (VALUES
  ('subscription.low_balance','Subscription balance low','Your wallet may not cover an upcoming subscription delivery.'),
  ('subscription.price_increase','Subscription price changed','Your subscription price has increased.')
) AS t(key,subject,body) CROSS JOIN (VALUES ('PUSH'),('INBOX')) AS c(channel) ON CONFLICT DO NOTHING;
ALTER TABLE pick_tasks ADD COLUMN available_at timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE delivery_tasks ADD COLUMN dispatch_not_before timestamptz NOT NULL DEFAULT '-infinity';

-- Down Migration
ALTER TABLE delivery_tasks DROP COLUMN dispatch_not_before;
ALTER TABLE pick_tasks DROP COLUMN available_at;
DELETE FROM notification_templates WHERE template_key IN ('subscription.low_balance','subscription.price_increase');
DROP TABLE subscription_alerts;
DROP TABLE subscription_occurrences;
DROP TABLE subscription_generation_runs;
DROP TABLE subscription_pauses;
DROP TABLE subscription_skips;
DROP TABLE subscription_schedule_versions;
DROP TABLE subscriptions;
DROP TABLE subscription_holidays;
DROP TABLE subscription_slots;
DROP TABLE subscription_plans;
