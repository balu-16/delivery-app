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
import { storageError } from '../../common/security/storage-errors.js';
import { validMediaMagic } from '../../common/security/media-magic.js';
import { uuidV7 } from '../../common/ids/ids.js';
import type { Database } from '../../platform/database/database.js';
import type { PrivateUploadPort } from '../../modules/identity/contracts/uploads.js';
/** P1 rider KYC port backed by private S3 staging and immutable final objects. */
export class S3PrivateUploads implements PrivateUploadPort {
  constructor(
    private readonly db: Database,
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly maxBytes: number,
    private readonly uploadTtl: number,
    private readonly readTtl: number,
  ) {}
  async createTarget(ownerId: string, purpose: 'RIDER_KYC', contentType: string, size: number) {
    if (
      !['image/jpeg', 'image/png', 'application/pdf'].includes(contentType) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > this.maxBytes
    )
      throw new Error('INVALID_MEDIA');
    const id = uuidV7(),
      nonce = uuidV7();
    await this.db.transaction().execute(async (tx) => {
      const actor =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${ownerId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='RIDER' AND EXISTS (SELECT 1 FROM rider_profiles p WHERE p.user_id=u.id AND p.status IN ('PENDING','REJECTED')) FOR SHARE OF u,r`.execute(
          tx,
        );
      if (!actor.rows.length) throw new Error('FORBIDDEN');
      await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce) VALUES(${id}::uuid,${ownerId}::uuid,${purpose},${contentType},${size},'PENDING',${nonce}::uuid)`.execute(
        tx,
      );
      await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${`kyc/staging/${id}/${nonce}`},clock_timestamp()+(${this.uploadTtl}+600)*interval '1 second')`.execute(
        tx,
      );
    });
    let target;
    try {
      target = await createPresignedPost(this.s3, {
        Bucket: this.bucket,
        Key: `kyc/staging/${id}/${nonce}`,
        Expires: this.uploadTtl,
        Fields: { 'Content-Type': contentType },
        Conditions: [['content-length-range', size, size], { 'Content-Type': contentType }],
      });
    } catch (error) {
      throw storageError(error);
    }
    return { mediaId: id, ...target };
  }
  async assertOwnedRegistered(ownerId: string, mediaId: string, purpose: 'RIDER_KYC') {
    const result = await sql<{
      state: string;
      upload_nonce: string;
      content_type: string;
      size_bytes: number;
    }>`SELECT state,upload_nonce,content_type,size_bytes FROM private_media WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid AND purpose=${purpose} AND (state='STORED' OR (state='PENDING' AND created_at+${this.uploadTtl}*interval '1 second'>clock_timestamp()))`.execute(
      this.db,
    );
    const row = result.rows[0];
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    if (row.state === 'STORED') return;
    const staging = `kyc/staging/${mediaId}/${row.upload_nonce}`;
    let head;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: staging }), {
        abortSignal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw storageError(error);
    }
    if (
      head.ContentType !== row.content_type ||
      head.ContentLength !== row.size_bytes ||
      !head.ETag
    )
      throw new Error('INVALID_MEDIA');
    const key = uuidV7(),
      final = `kyc/final/${key}`;
    await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${final},clock_timestamp()+interval '10 minutes')`.execute(
      this.db,
    );
    try {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: final,
          CopySource: `${encodeURIComponent(this.bucket)}/${staging}`,
          CopySourceIfMatch: head.ETag,
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
    } catch (error) {
      throw storageError(error);
    }
    try {
      const object = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: final, Range: 'bytes=0-11' }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (
        !object.Body ||
        !validMediaMagic(row.content_type, await object.Body.transformToByteArray())
      )
        throw new Error('INVALID_MEDIA');
      await this.db.transaction().execute(async (tx) => {
        const updated =
          await sql`UPDATE private_media SET state='STORED',file_key=${key}::uuid WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid AND purpose=${purpose} AND state='PENDING' AND created_at+${this.uploadTtl}*interval '1 second'>clock_timestamp() RETURNING id`.execute(
            tx,
          );
        if (!updated.rows.length) throw new Error('MEDIA_NOT_FOUND');
        const promotion =
          await sql`DELETE FROM media_orphan_objects WHERE object_key=${final} AND lease_token IS NULL RETURNING object_key`.execute(
            tx,
          );
        if (!promotion.rows.length) throw new Error('MEDIA_NOT_FOUND');
      });
    } catch (error) {
      const referenced =
        await sql`SELECT id FROM private_media WHERE file_key=${key}::uuid AND state='STORED'`
          .execute(this.db)
          .catch(() => null);
      if (referenced && !referenced.rows.length)
        await this.s3
          .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: final }))
          .catch(() => undefined);
      if (error instanceof Error && ['INVALID_MEDIA', 'MEDIA_NOT_FOUND'].includes(error.message))
        throw error;
      throw storageError(error);
    }
    // Staging is removed by the durable queue after the signed target expires.
  }
  async signedRead(mediaId: string) {
    const result = await sql<{
      file_key: string;
    }>`SELECT file_key FROM private_media WHERE id=${mediaId}::uuid AND purpose='RIDER_KYC' AND state='STORED'`.execute(
      this.db,
    );
    if (!result.rows[0]) throw new Error('MEDIA_NOT_FOUND');
    try {
      return await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: `kyc/final/${result.rows[0].file_key}` }),
        { expiresIn: this.readTtl },
      );
    } catch (error) {
      throw storageError(error);
    }
  }
}
