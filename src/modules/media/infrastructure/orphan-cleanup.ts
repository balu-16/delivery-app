import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { StoragePort } from '../contracts/storage.js';
/** Delayed cleanup gives in-flight promotions time to commit. Objects are removed outside transactions. */
export class MediaOrphanCleanup {
  constructor(
    private readonly db: Database,
    private readonly storage: StoragePort,
  ) {}
  async runOne(): Promise<boolean> {
    const lease = uuidV7();
    const result = await sql<{
      object_key: string;
    }>`UPDATE media_orphan_objects SET lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '2 minutes' WHERE object_key=(
      SELECT o.object_key FROM media_orphan_objects o WHERE o.remove_after<=clock_timestamp() AND (o.lease_until IS NULL OR o.lease_until<clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM catalog_media m WHERE m.object_key=o.object_key AND m.state='REGISTERED')
      AND NOT EXISTS(SELECT 1 FROM catalog_import_jobs j WHERE j.report_key=o.object_key)
      ORDER BY o.remove_after,o.object_key FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING object_key`.execute(
      this.db,
    );
    const key = result.rows[0]?.object_key;
    if (!key) return false;
    try {
      await this.storage.remove(key);
      await this.db.transaction().execute(async (tx) => {
        const locked =
          await sql`SELECT object_key FROM media_orphan_objects WHERE object_key=${key} AND lease_token=${lease}::uuid FOR UPDATE`.execute(
            tx,
          );
        if (!locked.rows.length) return;
        await sql`DELETE FROM catalog_media WHERE object_key=${key} AND state='PENDING' AND expires_at<clock_timestamp()`.execute(
          tx,
        );
        if (key.startsWith('kyc/staging/'))
          await sql`DELETE FROM private_media WHERE state='PENDING' AND id::text=split_part(${key},'/',3) AND upload_nonce::text=split_part(${key},'/',4)`.execute(
            tx,
          );
        await sql`DELETE FROM media_orphan_objects WHERE object_key=${key} AND lease_token=${lease}::uuid`.execute(
          tx,
        );
      });
    } catch (error) {
      await sql`UPDATE media_orphan_objects SET attempts=attempts+1,remove_after=clock_timestamp()+least(3600,power(2,least(attempts+1,12))) * interval '1 second',lease_token=NULL,lease_until=NULL WHERE object_key=${key} AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      throw error;
    }
    return true;
  }
}
