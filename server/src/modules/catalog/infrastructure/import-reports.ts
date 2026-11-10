import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { StoragePort } from '../../media/contracts/storage.js';
import { csvCell } from '../domain/import.js';
interface ReportJob {
  id: string;
  errors: Array<{ row: number; code: string }>;
  report_key: string | null;
}
/** Durable report leases and pre-write intents let any worker safely recover after a crash. */
export class ImportReports {
  constructor(
    private readonly db: Database,
    private readonly storage: StoragePort,
  ) {}
  async recoverOne(jobId?: string): Promise<boolean> {
    const token = uuidV7();
    const claimed =
      await sql<ReportJob>`UPDATE catalog_import_jobs SET report_lease_token=${token}::uuid,report_lease_until=clock_timestamp()+interval '5 minutes' WHERE id=(SELECT id FROM catalog_import_jobs WHERE (${jobId ?? null}::uuid IS NULL OR id=${jobId ?? null}::uuid) AND status IN ('AWAITING_APPROVAL','APPLYING','COMPLETED','FAILED') AND (report_key IS NULL OR report_errors IS DISTINCT FROM errors) AND (report_lease_until IS NULL OR report_lease_until<clock_timestamp()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,errors,report_key`.execute(
        this.db,
      );
    const job = claimed.rows[0];
    if (!job) return false;
    const key = `private/${job.id}/${uuidV7()}`;
    await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${key},clock_timestamp()+interval '10 minutes')`.execute(
      this.db,
    );
    const body = Buffer.from(
      ['row,error', ...job.errors.map((e) => `${e.row},${csvCell(e.code)}`)].join('\r\n') + '\r\n',
      'utf8',
    );
    try {
      await this.storage.putPrivate(key, body, 'text/csv');
      await this.db.transaction().execute(async (tx) => {
        const saved =
          await sql`UPDATE catalog_import_jobs SET report_key=${key},report_errors=${JSON.stringify(job.errors)}::jsonb,report_lease_token=NULL,report_lease_until=NULL WHERE id=${job.id}::uuid AND report_lease_token=${token}::uuid AND report_lease_until>clock_timestamp() AND errors=${JSON.stringify(job.errors)}::jsonb RETURNING id`.execute(
            tx,
          );
        if (!saved.rows.length) throw new Error('REPORT_LEASE_LOST');
        const keep =
          await sql`DELETE FROM media_orphan_objects WHERE object_key=${key} AND lease_token IS NULL RETURNING object_key`.execute(
            tx,
          );
        if (!keep.rows.length) throw new Error('REPORT_LEASE_LOST');
        if (job.report_key)
          await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${job.report_key},clock_timestamp()+interval '10 minutes') ON CONFLICT(object_key) DO NOTHING`.execute(
            tx,
          );
      });
    } catch (error) {
      await sql`UPDATE catalog_import_jobs SET report_lease_token=NULL,report_lease_until=NULL WHERE id=${job.id}::uuid AND report_lease_token=${token}::uuid`
        .execute(this.db)
        .catch(() => undefined);
      throw error;
    }
    return true;
  }
}
