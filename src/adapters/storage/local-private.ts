import { createHmac } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { sql } from 'kysely';
import { uuidV7 } from '../../common/ids/ids.js';
import type { Database } from '../../platform/database/database.js';
import type { PrivateUploadPort } from '../../modules/identity/contracts/uploads.js';

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
    ttl: number,
    ownerId: string,
    nonce?: string,
  ): Promise<string> {
    return new SignJWT({ operation, ownerId, purpose: 'RIDER_KYC', nonce })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('delivery-private-media')
      .setAudience('private-media')
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(this.key);
  }
  private async verify(
    id: string,
    token: string,
    operation: string,
  ): Promise<{ ownerId: string; nonce: string | undefined }> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: 'delivery-private-media',
      audience: 'private-media',
      algorithms: ['HS256'],
    });
    if (
      payload.sub !== id ||
      payload.operation !== operation ||
      payload.purpose !== 'RIDER_KYC' ||
      typeof payload.ownerId !== 'string'
    )
      throw new Error('INVALID_MEDIA_CAPABILITY');
    return {
      ownerId: payload.ownerId,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
    };
  }
  async createTarget(
    ownerId: string,
    purpose: 'RIDER_KYC',
    contentType: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }> {
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
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${ownerId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='RIDER' AND EXISTS (SELECT 1 FROM rider_profiles p WHERE p.user_id=u.id AND p.status IN ('PENDING','REJECTED')) FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce) VALUES (${id}::uuid,${ownerId}::uuid,${purpose},${contentType},${size},'PENDING',${nonce}::uuid)`.execute(
        tx,
      );
    });
    return {
      mediaId: id,
      url: `/dev/private-media/${id}`,
      fields: {
        authorization: `Bearer ${await this.sign(id, 'upload', this.uploadTtl, ownerId, nonce)}`,
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
    }>`UPDATE private_media SET state='UPLOADING',lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=${id}::uuid AND owner_id=${capability.ownerId}::uuid AND purpose='RIDER_KYC' AND upload_nonce=${nonce}::uuid AND (state='PENDING' OR (state='UPLOADING' AND lease_until<clock_timestamp())) RETURNING size_bytes,content_type`.execute(
      this.db,
    );
    if (!claimed.rows[0] || claimed.rows[0].size_bytes !== body.length) {
      if (claimed.rows[0])
        await sql`UPDATE private_media SET state='PENDING',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid AND lease_token=${lease}::uuid`.execute(
          this.db,
        );
      throw new Error('INVALID_MEDIA');
    }
    const contentType = claimed.rows[0].content_type;
    const validMagic =
      contentType === 'image/jpeg'
        ? body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        : contentType === 'image/png'
          ? body
              .subarray(0, 8)
              .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : body.subarray(0, 5).toString('ascii') === '%PDF-';
    if (!validMagic) {
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
      await unlink(path).catch(() => undefined);
      await sql`UPDATE private_media SET state='PENDING',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      throw error;
    }
  }
  async assertOwnedRegistered(
    ownerId: string,
    mediaId: string,
    purpose: 'RIDER_KYC',
  ): Promise<void> {
    const found = await sql<{
      id: string;
    }>`SELECT id FROM private_media WHERE id=${mediaId}::uuid AND owner_id=${ownerId}::uuid AND purpose=${purpose} AND state='STORED'`.execute(
      this.db,
    );
    if (!found.rows[0]) throw new Error('MEDIA_NOT_FOUND');
  }
  async signedRead(mediaId: string): Promise<string> {
    const media = await sql<{
      owner_id: string;
    }>`SELECT owner_id FROM private_media WHERE id=${mediaId}::uuid AND purpose='RIDER_KYC' AND state='STORED'`.execute(
      this.db,
    );
    if (!media.rows[0]) throw new Error('MEDIA_NOT_FOUND');
    return `/dev/private-media/${mediaId}?capability=${encodeURIComponent(await this.sign(mediaId, 'read', this.readTtl, media.rows[0].owner_id))}`;
  }
  async read(id: string, capability: string): Promise<{ body: Buffer; contentType: string }> {
    const verified = await this.verify(id, capability, 'read');
    const found = await sql<{
      file_key: string;
      content_type: string;
    }>`SELECT file_key,content_type FROM private_media WHERE id=${id}::uuid AND owner_id=${verified.ownerId}::uuid AND purpose='RIDER_KYC' AND state='STORED'`.execute(
      this.db,
    );
    const row = found.rows[0];
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    return {
      body: await readFile(resolve(this.directory, row.file_key)),
      contentType: row.content_type,
    };
  }
}
