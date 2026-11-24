import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sql } from 'kysely';
import type { TransactionContext } from '../../platform/database/database.js';
import { fencePrivateMedia, erasePrivateMedia } from './private-erasure.js';
import { storageError } from '../../common/security/storage-errors.js';
import { validMediaMagic } from '../../common/security/media-magic.js';
import { PROFILE_COVER_PURPOSE } from '../../modules/identity/contracts/profile-covers.js';
import { uuidV7 } from '../../common/ids/ids.js';
import type { Database } from '../../platform/database/database.js';
import type {
  PreparedPrivateUpload,
  PrivateMediaPurpose,
  PrivateUploadPort,
  PrivateUploadTarget,
} from '../../modules/identity/contracts/uploads.js';
const STAGING_GRACE_SECONDS = 600;

/** P1 rider KYC port backed by private S3 staging and immutable final objects. */
export class S3PrivateUploads implements PrivateUploadPort {
  constructor(
    private readonly db: Database,
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly maxBytes: number,
    private readonly uploadTtl: number,
    private readonly readTtl: number,
    private readonly metrics?: { observeStage(stage: string, ms: number): void },
  ) {}
  private recordStage(name: string, start: number) {
    try {
      const ms = performance.now() - start;
      // bounded rider op+phase names only, no filenames/contents
      this.metrics?.observeStage(name, ms);
    } catch {
      /* metrics must not affect upload */
    }
  }
  fenceForErasure(userId: string, tx: TransactionContext): Promise<void> {
    return fencePrivateMedia(tx, userId, 's3', this.uploadTtl, this.readTtl);
  }
  eraseFenced(userId: string): Promise<boolean> {
    return erasePrivateMedia(this.db, userId, async (key) => {
      if (!/^kyc\/(?:final\/[0-9a-f-]{36}|staging\/[0-9a-f-]{36}\/[0-9a-f-]{36})$/i.test(key))
        throw new Error('INVALID_MEDIA_KEY');
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(10000),
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
    const createdAt = await this.db.transaction().execute(async (tx) => {
      const actor =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${ownerId}::uuid AND u.status='ACTIVE' AND ((r.role='RIDER' AND u.pool='WORKFORCE' AND EXISTS (SELECT 1 FROM rider_profiles p WHERE p.user_id=u.id AND (( ${purpose} = 'RIDER_KYC' AND p.status IN ('PENDING','REJECTED')) OR (${purpose} = 'DELIVERY_POD' AND p.status='APPROVED')))) OR (${purpose}='SUPPORT_ATTACHMENT' AND r.role IN ('CUSTOMER','RIDER','SUPPORT_AGENT','SUPER_ADMIN')) OR (${purpose}='PAYOUT_EVIDENCE' AND u.pool='WORKFORCE' AND r.role IN ('SUPER_ADMIN')) OR (${purpose}=${PROFILE_COVER_PURPOSE} AND u.pool='CUSTOMER' AND r.role='CUSTOMER')) FOR SHARE OF u,r`.execute(
          tx,
        );
      if (!actor.rows.length) throw new Error('FORBIDDEN');
      const media = await sql<{
        created_at: Date;
      }>`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce,created_at) VALUES(${id}::uuid,${ownerId}::uuid,${purpose},${contentType},${size},'PENDING',${nonce}::uuid,clock_timestamp()) RETURNING created_at`.execute(
        tx,
      );
      const createdAt = media.rows[0]!.created_at;
      const cleanupAt = new Date(
        createdAt.getTime() + (this.uploadTtl + STAGING_GRACE_SECONDS) * 1000,
      );
      await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${`kyc/staging/${id}/${nonce}`},${cleanupAt.toISOString()}::timestamptz)`.execute(
        tx,
      );
      return createdAt;
    });
    try {
      const target = await createPresignedPost(this.s3, {
        Bucket: this.bucket,
        Key: `kyc/staging/${id}/${nonce}`,
        Expires: this.uploadTtl,
        Fields: { 'Content-Type': contentType },
        Conditions: [['content-length-range', size, size], { 'Content-Type': contentType }],
      });
      const policy = JSON.parse(Buffer.from(target.fields['Policy']!, 'base64').toString()) as {
        expiration: string;
      };
      const expiresAt = new Date(
        Math.min(Date.parse(policy.expiration), createdAt.getTime() + this.uploadTtl * 1000),
      ).toISOString();
      return { mediaId: id, ...target, expiresAt };
    } catch (error) {
      throw storageError(error);
    }
  }

  async prepareOwnedUpload(
    ownerId: string,
    mediaId: string,
    purpose: PrivateMediaPurpose,
  ): Promise<PreparedPrivateUpload> {
    const confirmSeconds = this.uploadTtl + STAGING_GRACE_SECONDS;
    const lookup = await sql<{
      state: string;
      upload_nonce: string;
      content_type: string;
      size_bytes: number;
      confirmable: boolean;
      promoting: boolean;
    }>`SELECT state,upload_nonce,content_type,size_bytes,
        created_at+${confirmSeconds}*interval '1 second'>clock_timestamp() AS confirmable,
        state='UPLOADING' AND lease_until>clock_timestamp() AS promoting
        FROM private_media WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid AND purpose=${purpose}`.execute(
      this.db,
    );
    const row = lookup.rows[0];
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    const stored: PreparedPrivateUpload = {
      commit: async (tx) => {
        const owned = await sql`SELECT id FROM private_media WHERE id=${mediaId}::uuid
          AND owner_id=${ownerId}::uuid AND purpose=${purpose} AND state='STORED'
          AND file_key IS NOT NULL FOR SHARE`.execute(tx);
        if (!owned.rows.length) throw new Error('MEDIA_NOT_FOUND');
      },
      release: async () => {},
    };
    if (row.state === 'STORED') return stored;
    if (row.state !== 'PENDING' && row.state !== 'UPLOADING') throw new Error('MEDIA_NOT_FOUND');
    if (row.promoting) throw new Error('UPLOAD_PROCESSING');
    if (!row.confirmable) throw new Error('UPLOAD_EXPIRED');
    const staging = `kyc/staging/${mediaId}/${row.upload_nonce}`;
    const headStarted = performance.now();
    let head;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: staging }), {
        abortSignal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw storageError(error, 'UPLOAD_NOT_RECEIVED');
    }
    this.recordStage('rider_upload_head', headStarted);
    if (
      head.ContentType !== row.content_type ||
      head.ContentLength !== row.size_bytes ||
      !head.ETag
    ) {
      throw new Error('INVALID_MEDIA');
    }

    const lease = uuidV7();
    const final = `kyc/final/${lease}`;
    const claimStarted = performance.now();
    const claimed = await this.db.transaction().execute(async (tx) => {
      const owner =
        await sql`SELECT id FROM users WHERE id=${ownerId}::uuid AND status='ACTIVE' FOR SHARE`.execute(
          tx,
        );
      if (!owner.rows.length) throw new Error('MEDIA_NOT_FOUND');
      const current = await sql<{
        state: string;
        confirmable: boolean;
        promoting: boolean;
      }>`SELECT state,created_at+${confirmSeconds}*interval '1 second'>clock_timestamp() AS confirmable,
          state='UPLOADING' AND lease_until>clock_timestamp() AS promoting FROM private_media
          WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid AND purpose=${purpose} FOR UPDATE`.execute(
        tx,
      );
      const fresh = current.rows[0];
      if (!fresh) throw new Error('MEDIA_NOT_FOUND');
      if (fresh.state === 'STORED') return false;
      if (fresh.state !== 'PENDING' && fresh.state !== 'UPLOADING')
        throw new Error('MEDIA_NOT_FOUND');
      if (fresh.promoting) throw new Error('UPLOAD_PROCESSING');
      if (!fresh.confirmable) throw new Error('UPLOAD_EXPIRED');

      // The cleanup worker claims the same row. Keep the bytes available
      // through this lease even if confirmation begins just before expiry.
      const staged = await sql`UPDATE media_orphan_objects
        SET remove_after=GREATEST(remove_after,clock_timestamp()+interval '5 minutes')
        WHERE object_key=${staging} AND lease_token IS NULL AND remove_after>clock_timestamp()
        RETURNING object_key`.execute(tx);
      if (!staged.rows.length) throw new Error('UPLOAD_EXPIRED');
      await sql`UPDATE private_media SET state='UPLOADING',lease_token=${lease}::uuid,
        lease_until=clock_timestamp()+interval '5 minutes' WHERE id=${mediaId}::uuid`.execute(tx);
      await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${final},clock_timestamp()+interval '10 minutes')`.execute(
        tx,
      );
      await sql`INSERT INTO private_media_promotions(media_id,object_key) VALUES (${mediaId}::uuid,${final})`.execute(
        tx,
      );
      return true;
    });
    if (!claimed) return stored;
    this.recordStage('rider_upload_claim', claimStarted);

    const release = async () => {
      // Retain both durable cleanup records, including after an ambiguous
      // database commit. Only the holder of this lease may make it retryable.
      await sql`UPDATE private_media SET state='PENDING',lease_token=NULL,lease_until=NULL
        WHERE id=${mediaId}::uuid AND state='UPLOADING' AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
    };
    try {
      const copyStarted = performance.now();
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: final,
          CopySource: `${encodeURIComponent(this.bucket)}/${staging}`,
          CopySourceIfMatch: head.ETag,
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      this.recordStage('rider_upload_copy', copyStarted);

      const verifyStarted = performance.now();
      const object = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: final, Range: 'bytes=0-11' }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (
        !object.Body ||
        !validMediaMagic(row.content_type, await object.Body.transformToByteArray())
      )
        throw new Error('INVALID_MEDIA');
      this.recordStage('rider_upload_verify', verifyStarted);
    } catch (error) {
      await release().catch(() => undefined);
      throw storageError(error);
    }

    return {
      release,
      commit: async (tx) => {
        const commitStarted = performance.now();
        const updated = await sql`UPDATE private_media SET state='STORED',file_key=${lease}::uuid,
          lease_token=NULL,lease_until=NULL WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid
          AND purpose=${purpose} AND state='UPLOADING' AND lease_token=${lease}::uuid
          AND lease_until>clock_timestamp() RETURNING id`.execute(tx);
        if (!updated.rows.length) throw new Error('UPLOAD_PROCESSING');
        const promotion = await sql`DELETE FROM media_orphan_objects WHERE object_key=${final}
          AND lease_token IS NULL RETURNING object_key`.execute(tx);
        if (!promotion.rows.length) throw new Error('UPLOAD_PROCESSING');
        this.recordStage('rider_upload_commit', commitStarted);
      },
    };
  }

  async assertOwnedRegistered(ownerId: string, mediaId: string, purpose: PrivateMediaPurpose) {
    let prepared: PreparedPrivateUpload | undefined;
    try {
      prepared = await this.prepareOwnedUpload(ownerId, mediaId, purpose);
      await this.db.transaction().execute(prepared.commit);
    } catch (error) {
      await prepared?.release().catch(() => undefined);
      if (
        error instanceof Error &&
        ['UPLOAD_NOT_RECEIVED', 'UPLOAD_PROCESSING', 'UPLOAD_EXPIRED'].includes(error.message)
      )
        throw new Error('MEDIA_NOT_FOUND', { cause: error });
      throw error;
    }
  }
  async signedRead(mediaId: string, coverOwnerId?: string) {
    const scope = coverOwnerId
      ? sql`m.purpose=${PROFILE_COVER_PURPOSE} AND m.owner_id=${coverOwnerId}::uuid
          AND EXISTS(SELECT 1 FROM customer_profiles p JOIN users u ON u.id=p.user_id
            WHERE p.user_id=m.owner_id AND p.cover_media_id=m.id AND u.status='ACTIVE')`
      : sql`m.purpose IN ('RIDER_KYC','SUPPORT_ATTACHMENT','PAYOUT_EVIDENCE')`;
    const result = await sql<{
      file_key: string;
    }>`SELECT m.file_key FROM private_media m WHERE m.id=${mediaId}::uuid AND m.state='STORED' AND ${scope}`.execute(
      this.db,
    );
    if (!result.rows[0]) throw new Error('MEDIA_NOT_FOUND');
    try {
      return await getSignedUrl(
        this.s3,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `kyc/final/${result.rows[0].file_key}`,
          ...(coverOwnerId ? { ResponseCacheControl: 'private, no-store' } : {}),
        }),
        { expiresIn: this.readTtl },
      );
    } catch (error) {
      throw storageError(error);
    }
  }
}
