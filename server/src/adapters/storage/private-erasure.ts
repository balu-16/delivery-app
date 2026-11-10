import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../platform/database/database.js';

/** Called after the owner account lock. The fence invalidates registrations and captures all in-flight keys. */
export async function fencePrivateMedia(
  tx: TransactionContext,
  userId: string,
  mode: 'local' | 's3',
  uploadTtl: number,
  readTtl: number,
): Promise<void> {
  const media = await sql<{
    id: string;
    file_key: string | null;
    lease_token: string | null;
    upload_nonce: string;
  }>`SELECT id,file_key,lease_token,upload_nonce FROM private_media
    WHERE owner_id=${userId}::uuid AND purpose<>'PAYOUT_EVIDENCE' AND state<>'ERASING' FOR UPDATE`.execute(
    tx,
  );
  const waitSeconds = media.rows.length ? Math.max(uploadTtl, readTtl, 300) + 600 : 0;
  await sql`INSERT INTO privacy_media_fences(owner_id,ready_at) VALUES (${userId}::uuid,clock_timestamp()+${waitSeconds}*interval '1 second') ON CONFLICT(owner_id) DO UPDATE SET ready_at=GREATEST(privacy_media_fences.ready_at,EXCLUDED.ready_at)`.execute(
    tx,
  );
  for (const row of media.rows) {
    const keys =
      mode === 's3'
        ? [
            `kyc/staging/${row.id}/${row.upload_nonce}`,
            ...(row.file_key ? [`kyc/final/${row.file_key}`] : []),
            ...(row.lease_token ? [`kyc/final/${row.lease_token}`] : []),
          ]
        : [row.file_key, row.lease_token].filter((value): value is string => !!value);
    for (const key of keys)
      await sql`INSERT INTO privacy_media_cleanup_objects(owner_id,object_key) VALUES (${userId}::uuid,${key}) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
  }
  if (mode === 's3')
    await sql`INSERT INTO privacy_media_cleanup_objects(owner_id,object_key)
    SELECT ${userId}::uuid,p.object_key FROM private_media_promotions p JOIN private_media m ON m.id=p.media_id
    WHERE m.owner_id=${userId}::uuid AND m.purpose<>'PAYOUT_EVIDENCE' ON CONFLICT DO NOTHING`.execute(
      tx,
    );
  await sql`UPDATE private_media SET state='ERASING',lease_token=NULL,lease_until=NULL WHERE owner_id=${userId}::uuid AND purpose<>'PAYOUT_EVIDENCE' AND state<>'ERASING'`.execute(
    tx,
  );
}

/** A failed deletion leaves its durable key in place for the next attempt. */
export async function erasePrivateMedia(
  db: Database,
  userId: string,
  remove: (key: string) => Promise<void>,
): Promise<boolean> {
  const fence = await sql<{
    ready: boolean;
  }>`SELECT ready_at<=clock_timestamp() AS ready FROM privacy_media_fences WHERE owner_id=${userId}::uuid`.execute(
    db,
  );
  if (!fence.rows[0]?.ready) return false;
  const keys = await sql<{
    object_key: string;
  }>`SELECT object_key FROM privacy_media_cleanup_objects WHERE owner_id=${userId}::uuid ORDER BY object_key LIMIT 100`.execute(
    db,
  );
  for (const row of keys.rows) {
    await remove(row.object_key);
    await sql`DELETE FROM privacy_media_cleanup_objects WHERE owner_id=${userId}::uuid AND object_key=${row.object_key}`.execute(
      db,
    );
  }
  const remaining =
    await sql`SELECT 1 FROM privacy_media_cleanup_objects WHERE owner_id=${userId}::uuid LIMIT 1`.execute(
      db,
    );
  return !remaining.rows.length;
}
