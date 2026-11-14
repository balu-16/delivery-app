-- Up Migration
-- Preserve customized templates; the old default incorrectly promised that a
-- rider could go online after any single document was approved.
UPDATE notification_templates SET body='Your document was approved. Check your application for its status.'
WHERE template_key='rider.document.approved' AND locale='en' AND channel='PUSH'
  AND body='Your document was approved. You can go online.';

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'migration 037 is forward-only'; END $$;
