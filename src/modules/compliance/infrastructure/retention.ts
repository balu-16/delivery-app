import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
/** Retain notification dedupe tombstones and financial/operation references indefinitely. */
export class ComplianceRetention {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}
  async runOnce(): Promise<void> {
    const batch = await this.config.get('retentionBatchSize');
    const days = await this.config.get('notificationRetentionDays');
    const hours = await this.config.get('responseCacheRetentionHours');
    await sql`WITH old AS (SELECT id FROM notifications WHERE retention_anonymized_at IS NULL AND status IN ('SENT','FAILED','SKIPPED') AND created_at < clock_timestamp()-${days}*interval '1 day' ORDER BY created_at,id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
      UPDATE notifications n SET payload='{}'::jsonb,error=NULL,retention_anonymized_at=clock_timestamp() FROM old WHERE n.id=old.id`.execute(
      this.db,
    );
    await sql`WITH old AS (SELECT actor,audience,method,resource,key FROM idempotency_keys WHERE state='COMPLETED' AND response_body IS NOT NULL AND response_expires_at<=clock_timestamp() AND updated_at<=clock_timestamp()-${hours}*interval '1 hour' ORDER BY response_expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)
      UPDATE idempotency_keys i SET response_status=NULL,response_body=NULL,response_expires_at=NULL FROM old WHERE i.actor=old.actor AND i.audience=old.audience AND i.method=old.method AND i.resource=old.resource AND i.key=old.key`.execute(
      this.db,
    );
  }
}
