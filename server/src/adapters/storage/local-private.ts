import { createHmac } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database, TransactionContext } from '../../platform/database/database.js';
import { fencePrivateMedia, erasePrivateMedia } from './private-erasure.js';
import { SignJWT, jwtVerify } from 'jose';
import { sql } from 'kysely';
import { uuidV7 } from '../../common/ids/ids.js';
import { validMediaMagic } from '../../common/security/media-magic.js';
import { PROFILE_COVER_PURPOSE } from '../../modules/identity/contracts/profile-covers.js';
import type {
  PreparedPrivateUpload,
  PrivateMediaPurpose,
  PrivateUploadPort,
  PrivateUploadTarget,
} from '../../modules/identity/contracts/uploads.js';

/** Local development disk storage. Capabilities are scoped and never reveal filesystem paths. */
export class LocalPrivateUploads implements PrivateUploadPort {
  private readonly key: Uint8Array;
  constructor(
    private readonly db: Database,
    secret: string,
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly uploadTtl: number,
    private readonly readTtl: number,
  ) {
    this.key = createHmac('sha256', secret).update('delivery:private-media:v1').digest();
  }
  private async sign(
    id: string,
    operation: string,
    expiresAt: number,
    ownerId: string,
    nonce?: string,
    purpose: PrivateMediaPurpose = 'RIDER_KYC',
  ): Promise<string> {
    return new SignJWT({ operation, ownerId, purpose, nonce })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('delivery-private-media')
      .setAudience('private-media')
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.key);
  }
  private async verify(
    id: string,
    token: string,
    operation: string,
  ): Promise<{
    ownerId: string;
    nonce: string | undefined;
    purpose: PrivateMediaPurpose;
  }> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: 'delivery-private-media',
      audience: 'private-media',
      algorithms: ['HS256'],
    });
    if (
      payload.sub !== id ||
      payload.operation !== operation ||
      (payload.purpose !== 'RIDER_KYC' &&
        payload.purpose !== 'DELIVERY_POD' &&
        payload.purpose !== 'SUPPORT_ATTACHMENT' &&
        payload.purpose !== 'PAYOUT_EVIDENCE' &&
        payload.purpose !== PROFILE_COVER_PURPOSE) ||
      typeof payload.ownerId !== 'string'
    )
      throw new Error('INVALID_MEDIA_CAPABILITY');
    return {
      ownerId: payload.ownerId,
      purpose: payload.purpose,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
    };
  }
  fenceForErasure(userId: string, tx: TransactionContext): Promise<void> {
    return fencePrivateMedia(tx, userId, 'local', this.uploadTtl, this.readTtl);
  }
  eraseFenced(userId: string): Promise<boolean> {
    return erasePrivateMedia(this.db, userId, async (key) => {
      if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('INVALID_MEDIA_KEY');
      await unlink(resolve(this.directory, key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
  }
  async createTarget(
    ownerId: string,
    purpose: PrivateMediaPurpose,
    contentType: string,
    size: number,
  ): Promise<PrivateUploadTarget> {
    if (
      !['image/jpeg', 'image/png', 'application/pdf'].includes(contentType) ||
      (purpose === PROFILE_COVER_PURPOSE && contentType !== 'image/jpeg') ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > this.maxBytes
    )
      throw new Error('INVALID_MEDIA');
    const id = uuidV7(),
      nonce = uuidV7();
    await this.db.transaction().execute(async (tx) => {
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${ownerId}::uuid AND u.status='ACTIVE' AND ((r.role='RIDER' AND u.pool='WORKFORCE' AND EXISTS (SELECT 1 FROM rider_profiles p WHERE p.user_id=u.id AND (( ${purpose} = 'RIDER_KYC' AND p.status IN ('PENDING','REJECTED')) OR (${purpose} = 'DELIVERY_POD' AND p.status='APPROVED')))) OR (${purpose}='SUPPORT_ATTACHMENT' AND r.role IN ('CUSTOMER','RIDER','SUPPORT_AGENT','SUPER_ADMIN')) OR (${purpose}='PAYOUT_EVIDENCE' AND u.pool='WORKFORCE' AND r.role IN ('SUPER_ADMIN')) OR (${purpose}=${PROFILE_COVER_PURPOSE} AND u.pool='CUSTOMER' AND r.role='CUSTOMER')) FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce) VALUES (${id}::uuid,${ownerId}::uuid,${purpose},${contentType},${size},'PENDING',${nonce}::uuid)`.execute(
        tx,
      );
      if (purpose === PROFILE_COVER_PURPOSE)
        await sql`INSERT INTO media_orphan_objects(object_key,remove_after)
          VALUES (${`kyc/staging/${id}/${nonce}`},clock_timestamp()+(${this.uploadTtl}+600)*interval '1 second')`.execute(
          tx,
        );
    });
    const expiresAt = Math.floor(Date.now() / 1000) + this.uploadTtl;
    return {
      mediaId: id,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      url: `/dev/private-media/${id}`,
      fields: {
        authorization: `Bearer ${await this.sign(id, 'upload', expiresAt, ownerId, nonce, purpose)}`,
      },
    };
  }
  async upload(id: string, token: string, body: Buffer): Promise<void> {
    const capability = await this.verify(id, token, 'upload');
    const nonce = capability.nonce;
    if (!nonce || !Buffer.isBuffer(body) || body.length > this.maxBytes)
      throw new Error('INVALID_MEDIA');
    const lease = uuidV7();
    const claimed = await sql<{
      size_bytes: number;
      content_type: string;
    }>`WITH claimed AS (
      UPDATE private_media SET state='UPLOADING',lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=${id}::uuid AND owner_id=${capability.ownerId}::uuid AND purpose=${capability.purpose} AND upload_nonce=${nonce}::uuid AND (state='PENDING' OR (state='UPLOADING' AND lease_until<clock_timestamp())) RETURNING size_bytes,content_type
    ), cleanup AS (
      INSERT INTO media_orphan_objects(object_key,remove_after)
      SELECT ${`kyc/final/${lease}`},clock_timestamp()+(${this.uploadTtl}+600)*interval '1 second'
      FROM claimed WHERE ${capability.purpose}=${PROFILE_COVER_PURPOSE}
    ) SELECT * FROM claimed`.execute(this.db);
    if (!claimed.rows[0] || claimed.rows[0].size_bytes !== body.length) {
      if (claimed.rows[0])
        await sql`UPDATE private_media SET state='PENDING',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid AND lease_token=${lease}::uuid`.execute(
          this.db,
        );
      throw new Error('INVALID_MEDIA');
    }
    if (!validMediaMagic(claimed.rows[0].content_type, body.subarray(0, 12))) {
      await sql`UPDATE private_media SET state='PENDING',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      throw new Error('INVALID_MEDIA');
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = resolve(this.directory, lease);
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(body);
      } finally {
        await file.close();
      }
      const stored =
        await sql`UPDATE private_media SET state='STORED',file_key=${lease}::uuid,lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid AND lease_token=${lease}::uuid`.execute(
          this.db,
        );
      if (!stored.numAffectedRows) throw new Error('MEDIA_LEASE_EXPIRED');
    } catch (error: unknown) {
      if (capability.purpose !== PROFILE_COVER_PURPOSE) await unlink(path).catch(() => undefined);
      await sql`UPDATE private_media SET state='PENDING',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      throw error;
    }
  }
  async prepareOwnedUpload(
    ownerId: string,
    mediaId: string,
    purpose: PrivateMediaPurpose,
  ): Promise<PreparedPrivateUpload> {
    const found = await sql<{ state: string; promoting: boolean; expired: boolean }>`SELECT state,
      state='UPLOADING' AND lease_until>clock_timestamp() AS promoting,
      created_at+${this.uploadTtl}*interval '1 second'<=clock_timestamp() AS expired
      FROM private_media WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid AND purpose=${purpose}`.execute(
      this.db,
    );
    const row = found.rows[0];
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    if (row.state === 'STORED') {
      return {
        release: async () => {},
        commit: async (tx) => {
          const stored = await sql<{
            file_key: string;
          }>`SELECT file_key FROM private_media WHERE id=${mediaId}::uuid
            AND owner_id=${ownerId}::uuid AND purpose=${purpose} AND state='STORED'
            AND file_key IS NOT NULL FOR SHARE`.execute(tx);
          if (!stored.rows.length) throw new Error('MEDIA_NOT_FOUND');
          if (purpose === PROFILE_COVER_PURPOSE) {
            const cleanup = await sql`DELETE FROM media_orphan_objects
              WHERE object_key=${`kyc/final/${stored.rows[0]!.file_key}`} AND lease_token IS NULL
                AND remove_after>clock_timestamp() RETURNING object_key`.execute(tx);
            if (!cleanup.rows.length) throw new Error('UPLOAD_EXPIRED');
          }
        },
      };
    }
    if (row.state !== 'PENDING' && row.state !== 'UPLOADING') throw new Error('MEDIA_NOT_FOUND');
    if (row.promoting) throw new Error('UPLOAD_PROCESSING');
    if (row.expired) throw new Error('UPLOAD_EXPIRED');
    throw new Error('UPLOAD_NOT_RECEIVED');
  }
  async assertOwnedRegistered(
    ownerId: string,
    mediaId: string,
    purpose: PrivateMediaPurpose,
  ): Promise<void> {
    const found = await sql`SELECT id FROM private_media WHERE id=${mediaId}::uuid AND
      owner_id=${ownerId}::uuid AND purpose=${purpose} AND state='STORED'`.execute(this.db);
    if (!found.rows.length) throw new Error('MEDIA_NOT_FOUND');
  }
  async signedRead(mediaId: string, coverOwnerId?: string): Promise<string> {
    const scope = coverOwnerId
      ? sql`m.purpose=${PROFILE_COVER_PURPOSE} AND m.owner_id=${coverOwnerId}::uuid
          AND EXISTS(SELECT 1 FROM customer_profiles p JOIN users u ON u.id=p.user_id
            WHERE p.user_id=m.owner_id AND p.cover_media_id=m.id AND u.status='ACTIVE')`
      : sql`m.purpose IN ('RIDER_KYC','SUPPORT_ATTACHMENT','PAYOUT_EVIDENCE')`;
    const media = await sql<{
      owner_id: string;
      purpose: PrivateMediaPurpose;
    }>`SELECT m.owner_id,m.purpose FROM private_media m WHERE m.id=${mediaId}::uuid AND m.state='STORED' AND ${scope}`.execute(
      this.db,
    );
    if (!media.rows[0]) throw new Error('MEDIA_NOT_FOUND');
    return `/dev/private-media/${mediaId}?capability=${encodeURIComponent(await this.sign(mediaId, 'read', Math.floor(Date.now() / 1000) + this.readTtl, media.rows[0].owner_id, undefined, media.rows[0].purpose))}`;
  }
  async read(id: string, capability: string): Promise<{ body: Buffer; contentType: string }> {
    const verified = await this.verify(id, capability, 'read');
    const found = await sql<{
      file_key: string;
      content_type: string;
    }>`SELECT file_key,content_type FROM private_media m
      WHERE m.id=${id}::uuid AND m.owner_id=${verified.ownerId}::uuid AND m.purpose=${verified.purpose} AND m.state='STORED'
        AND (m.purpose IN ('RIDER_KYC','SUPPORT_ATTACHMENT','PAYOUT_EVIDENCE') OR (
          m.purpose=${PROFILE_COVER_PURPOSE} AND EXISTS(SELECT 1 FROM customer_profiles p JOIN users u ON u.id=p.user_id
            WHERE p.user_id=m.owner_id AND p.cover_media_id=m.id AND u.status='ACTIVE')
        ))`.execute(this.db);
    const row = found.rows[0];
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    return {
      body: await readFile(resolve(this.directory, row.file_key)),
      contentType: row.content_type,
    };
  }
}
