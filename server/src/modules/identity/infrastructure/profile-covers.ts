import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../contracts/identity.js';
import {
  PROFILE_COVER_MAX_BYTES,
  PROFILE_COVER_PURPOSE,
  type CoverPreset,
  type CoverSelection,
  type ProfileCover,
  type ProfileCovers,
} from '../contracts/profile-covers.js';
import type { PrivateUploadPort } from '../contracts/uploads.js';

type StoredCover = CoverSelection & { version: string };
type CoverRow = {
  cover_preset_id: CoverPreset | null;
  cover_media_id: string | null;
  version: string;
};

function selectionOf(row?: CoverRow): StoredCover {
  const version = row?.version ?? '0';
  if (row?.cover_media_id) return { kind: 'photo', mediaId: row.cover_media_id, version };
  if (row?.cover_preset_id) return { kind: 'preset', presetId: row.cover_preset_id, version };
  return { kind: 'default', version };
}

function matches(current: StoredCover, requested: CoverSelection): boolean {
  return (
    current.kind === requested.kind &&
    current.mediaId === requested.mediaId &&
    current.presetId === requested.presetId
  );
}

export class PostgresProfileCovers implements ProfileCovers {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly uploads: PrivateUploadPort,
  ) {}

  async uploadTarget(userId: string, size: number) {
    if (!Number.isSafeInteger(size) || size < 1 || size > PROFILE_COVER_MAX_BYTES)
      throw new Error('INVALID_MEDIA');
    return this.uploads.createTarget(userId, PROFILE_COVER_PURPOSE, 'image/jpeg', size);
  }

  private async current(userId: string, tx?: TransactionContext): Promise<StoredCover> {
    const result =
      await sql<CoverRow>`SELECT cover_preset_id,cover_media_id::text,cover_version::text AS version
      FROM customer_profiles WHERE user_id=${userId}::uuid ${tx ? sql`FOR UPDATE` : sql``}`.execute(
        tx ?? this.db,
      );
    return selectionOf(result.rows[0]);
  }

  private async view(userId: string, cover: StoredCover): Promise<ProfileCover> {
    const imageUrl =
      cover.kind === 'photo' ? await this.uploads.signedRead(cover.mediaId, userId) : null;
    return { ...cover, imageUrl };
  }

  async get(userId: string): Promise<ProfileCover> {
    const cover = await this.current(userId);
    try {
      return await this.view(userId, cover);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'MEDIA_NOT_FOUND') throw error;
      const latest = await this.current(userId);
      if (latest.version === cover.version) throw error;
      return this.view(userId, latest);
    }
  }

  async update(
    userId: string,
    selection: CoverSelection,
    expectedVersion: string,
  ): Promise<ProfileCover> {
    const before = await this.current(userId);
    if (!matches(before, selection) && before.version !== expectedVersion)
      throw new Error('CONCURRENT_MODIFICATION');
    const upload =
      selection.kind === 'photo' && !matches(before, selection)
        ? await this.uploads.prepareOwnedUpload(userId, selection.mediaId, PROFILE_COVER_PURPOSE)
        : undefined;

    try {
      const saved = await this.db.transaction().execute(async (tx) => {
        if (!(await this.identity.hasRole(userId, ['CUSTOMER'], tx))) throw new Error('FORBIDDEN');
        await sql`INSERT INTO customer_profiles(user_id) VALUES (${userId}::uuid) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
        const current = await this.current(userId, tx);
        // A retry of a successful save returns the current revision.
        if (matches(current, selection)) return current;
        if (current.version !== expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
        if (selection.kind === 'photo') {
          if (!upload) throw new Error('CONCURRENT_MODIFICATION');
          await upload.commit(tx);
        }
        const next = await sql<CoverRow>`UPDATE customer_profiles
          SET cover_preset_id=${selection.presetId ?? null},cover_media_id=${selection.mediaId ?? null}::uuid,
            cover_version=cover_version+1 WHERE user_id=${userId}::uuid
          RETURNING cover_preset_id,cover_media_id::text,cover_version::text AS version`.execute(
          tx,
        );
        if (current.mediaId) {
          await sql`WITH retired AS (
            UPDATE private_media SET state='ERASING',lease_token=NULL,lease_until=NULL
            WHERE id=${current.mediaId}::uuid AND owner_id=${userId}::uuid
              AND purpose=${PROFILE_COVER_PURPOSE} AND state='STORED' RETURNING file_key
          ) INSERT INTO media_orphan_objects(object_key,remove_after)
            SELECT 'kyc/final/'||file_key::text,clock_timestamp() FROM retired WHERE file_key IS NOT NULL
            ON CONFLICT (object_key) DO UPDATE SET remove_after=LEAST(media_orphan_objects.remove_after,EXCLUDED.remove_after)`.execute(
            tx,
          );
        }
        return selectionOf(next.rows[0]);
      });
      return await this.view(userId, saved);
    } catch (error) {
      await upload?.release().catch(() => undefined);
      throw error;
    }
  }
}
