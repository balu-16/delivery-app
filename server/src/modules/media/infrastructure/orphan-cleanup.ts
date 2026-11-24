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
      AND NOT EXISTS(SELECT 1 FROM catalog_media m WHERE m.object_key=o.object_key AND m.state='REGISTERED'
        AND (m.purpose<>'CONTENT_IMAGE' OR NOT EXISTS(SELECT 1 FROM app_content a WHERE a.image_media_id=m.id)))
      AND NOT EXISTS(SELECT 1 FROM push_campaigns c WHERE c.payload->>'imageMediaId' IS NOT NULL
        AND EXISTS(SELECT 1 FROM catalog_media m WHERE m.object_key=o.object_key AND m.id::text=c.payload->>'imageMediaId'))
      AND NOT EXISTS(SELECT 1 FROM catalog_import_jobs j WHERE j.report_key=o.object_key)
      AND NOT EXISTS(SELECT 1 FROM private_media m WHERE o.object_key='kyc/final/'||m.file_key::text AND m.state='STORED'
        AND (m.purpose<>'CUSTOMER_PROFILE_COVER' OR EXISTS(SELECT 1 FROM customer_profiles p
          WHERE p.user_id=m.owner_id AND p.cover_media_id=m.id)))
      AND NOT EXISTS(SELECT 1 FROM private_media m WHERE o.object_key='kyc/final/'||m.lease_token::text
        AND m.purpose='CUSTOMER_PROFILE_COVER' AND m.state='UPLOADING' AND m.lease_until>clock_timestamp())
      AND NOT EXISTS(
        SELECT 1 FROM private_media m WHERE o.object_key='kyc/staging/'||m.id::text||'/'||m.upload_nonce::text
        AND (m.state='UPLOADING' AND m.lease_until>clock_timestamp()
          OR m.state IN ('PENDING','UPLOADING') AND EXISTS(SELECT 1 FROM private_media_promotions p WHERE p.media_id=m.id))
      )
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
          await sql`WITH expired AS (
            SELECT m.id FROM private_media m
            WHERE (m.state='PENDING' OR (m.state='UPLOADING' AND m.lease_until<=clock_timestamp()))
              AND m.id::text=split_part(${key},'/',3) AND m.upload_nonce::text=split_part(${key},'/',4)
              AND NOT EXISTS(SELECT 1 FROM private_media_promotions p WHERE p.media_id=m.id)
            FOR UPDATE
          ), drop_unused_proof AS (
            DELETE FROM delivery_pod_media p USING expired WHERE p.media_id=expired.id
          )
          DELETE FROM private_media m USING expired WHERE m.id=expired.id`.execute(tx);
        if (key.startsWith('kyc/final/')) {
          await sql`DELETE FROM private_media_promotions WHERE object_key=${key}`.execute(tx);
          await sql`DELETE FROM private_media m
            WHERE m.file_key::text=split_part(${key},'/',3) AND m.purpose='CUSTOMER_PROFILE_COVER'
              AND m.state IN ('STORED','ERASING')
              AND NOT EXISTS(SELECT 1 FROM customer_profiles p
                WHERE p.user_id=m.owner_id AND p.cover_media_id=m.id)`.execute(tx);
        }
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
