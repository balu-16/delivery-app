-- Up Migration
-- Accepted jobs survive a disconnected phone. The conversation remains the
-- owner of messages and drafts; jobs contain references rather than message text.
CREATE TABLE agent_jobs (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  request_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message','resume')),
  client_message_id uuid,
  message_id uuid REFERENCES agent_messages(id) ON DELETE CASCADE,
  draft_id uuid REFERENCES agent_drafts(id) ON DELETE CASCADE,
  decision text CHECK (decision IN ('approve','reject')),
  locale text NOT NULL CHECK (locale IN ('en','hi','te')),
  state text NOT NULL CHECK (state IN ('queued','running','completed','waiting','failed','cancelled')),
  error_code text,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(thread_id,request_key),
  CHECK ((kind='message' AND message_id IS NOT NULL AND client_message_id IS NOT NULL AND draft_id IS NULL AND decision IS NULL)
      OR (kind='resume' AND message_id IS NULL AND client_message_id IS NULL AND draft_id IS NOT NULL AND decision IS NOT NULL))
);
CREATE UNIQUE INDEX agent_jobs_one_active_idx ON agent_jobs(thread_id) WHERE state IN ('queued','running');
CREATE INDEX agent_jobs_worker_idx ON agent_jobs(state,created_at,id) WHERE state IN ('queued','running');
CREATE INDEX agent_jobs_thread_idx ON agent_jobs(thread_id,created_at DESC,id DESC);

-- Bounded-lifetime event data is deleted after completion or with the thread.
-- IDs are cursors, not customer-visible timestamps or JavaScript numbers.
CREATE TABLE agent_job_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  event text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_job_events_run_idx ON agent_job_events(job_id,sequence);

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check CHECK (category IN
 ('ORDER_UPDATES','PAYMENTS','WALLET','RIDING','STORE_OPS','ADMIN','PROMOTIONS','ASSISTANT_UPDATES'));
ALTER TABLE notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check CHECK (category IN
 ('ORDER_UPDATES','PAYMENTS','WALLET','RIDING','STORE_OPS','ADMIN','PROMOTIONS','ASSISTANT_UPDATES'));

INSERT INTO notification_templates(template_key,locale,channel,subject,body) VALUES
 ('agent.reply_ready','en','PUSH','Assistant update','Your assistant has a reply. Tap to open the chat.'),
 ('agent.reply_ready','hi','PUSH','सहायक से अपडेट','आपके सहायक का जवाब तैयार है। चैट खोलने के लिए टैप करें।'),
 ('agent.reply_ready','te','PUSH','సహాయకుడి నుంచి అప్‌డేట్','మీ సహాయకుడి సమాధానం సిద్ధంగా ఉంది. చాట్ తెరవడానికి నొక్కండి.'),
 ('agent.needs_you','en','PUSH','Your assistant needs you','Open the chat to review the next step.'),
 ('agent.needs_you','hi','PUSH','सहायक को आपकी जरूरत है','अगला चरण देखने के लिए चैट खोलें।'),
 ('agent.needs_you','te','PUSH','సహాయకుడికి మీ స్పందన అవసరం','తదుపరి దశను చూడటానికి చాట్ తెరవండి.'),
 ('agent.run_failed','en','PUSH','Assistant update','Your request could not be completed. Open the chat for details.'),
 ('agent.run_failed','hi','PUSH','सहायक से अपडेट','आपका अनुरोध पूरा नहीं हो सका। जानकारी के लिए चैट खोलें।'),
 ('agent.run_failed','te','PUSH','సహాయకుడి నుంచి అప్‌డేట్','మీ అభ్యర్థన పూర్తికాలేదు. వివరాల కోసం చాట్ తెరవండి.');

-- Down Migration
-- Rollback requires the new notification rows/preferences to be handled first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM notifications WHERE category='ASSISTANT_UPDATES') OR
     EXISTS (SELECT 1 FROM notification_preferences WHERE category='ASSISTANT_UPDATES') THEN
    RAISE EXCEPTION 'Remove or migrate assistant notification data before rollback';
  END IF;
END $$;
DELETE FROM notification_templates WHERE template_key IN ('agent.reply_ready','agent.needs_you','agent.run_failed');
ALTER TABLE notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check CHECK (category IN
 ('ORDER_UPDATES','PAYMENTS','WALLET','RIDING','STORE_OPS','ADMIN','PROMOTIONS'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check CHECK (category IN
 ('ORDER_UPDATES','PAYMENTS','WALLET','RIDING','STORE_OPS','ADMIN','PROMOTIONS'));
DROP TABLE agent_job_events;
DROP TABLE agent_jobs;
