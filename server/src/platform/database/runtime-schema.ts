import { sql } from 'kysely';
import type { Database } from './database.js';

/** Resolve the runtime schema and SELECT grants without reading any application rows. */
export async function checkRuntimeSchema(db: Database, useSqs: boolean): Promise<void> {
  await sql`
    SELECT
      (SELECT ROW(rejection_code, rejection_status, rejected_at) FROM public.idempotency_keys LIMIT 0),
      (SELECT source FROM public.store_status_history LIMIT 0),
      (SELECT listed FROM public.store_inventory LIMIT 0),
      (SELECT image_revision FROM public.catalog_products LIMIT 0),
      (SELECT rejection_reason FROM public.catalog_import_jobs LIMIT 0),
      (SELECT review_required_documents FROM public.rider_profiles LIMIT 0),
      (SELECT ROW(cover_preset_id, cover_media_id, cover_version) FROM public.customer_profiles LIMIT 0),
      (SELECT ROW(rendered_title, rendered_body) FROM public.notifications LIMIT 0),
      (SELECT id FROM public.referral_invites LIMIT 0),
      (SELECT slot FROM public.app_content LIMIT 0),
      (SELECT id FROM public.app_content_history LIMIT 0),
      (SELECT template_key FROM public.notification_template_overrides LIMIT 0),
      (SELECT id FROM public.notification_template_history LIMIT 0)
    LIMIT 0
  `.execute(db);
  if (useSqs)
    await sql`SELECT j.id, s.scheduler_id, d.event_id, e.id, p.event_id
      FROM public.sqs_concern_jobs j
      CROSS JOIN public.sqs_concern_schedules s
      CROSS JOIN public.outbox_deliveries d
      CROSS JOIN public.outbox_events e
      CROSS JOIN public.processed_events p
      LIMIT 0`.execute(db);
}
