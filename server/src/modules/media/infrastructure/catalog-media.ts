import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { CatalogMedia, StoragePort } from '../contracts/storage.js';
import { validMediaMagic } from '../../../common/security/media-magic.js';
interface MediaRow {
  owner_id: string;
  purpose: string;
  object_key: string;
  content_type: string;
  size_bytes: string;
  state: string;
  expires_at: Date;
}
export class CatalogMediaService implements CatalogMedia {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly storage: StoragePort,
    private readonly config: AppConfig,
    private readonly uploadTtl: number,
  ) {}
  async target(
    owner: string,
    purpose: 'PRODUCT_IMAGE' | 'CATALOG_IMPORT',
    type: string,
    size: number,
  ) {
    if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const max = await this.config.get('catalogImportMaxBytes');
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > max ||
      !(purpose === 'PRODUCT_IMAGE'
        ? ['image/jpeg', 'image/png', 'image/webp'].includes(type)
        : type === 'text/csv')
    )
      throw new Error('INVALID_MEDIA');
    const id = uuidV7(),
      key = `staging/${id}/${uuidV7()}`;
    await this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${id}::uuid,${owner}::uuid,${purpose},${key},${type},${size},'PENDING',clock_timestamp()+${this.uploadTtl}*interval '1 second')`.execute(
        tx,
      );
      await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${key},clock_timestamp()+(${this.uploadTtl}+600)*interval '1 second')`.execute(
        tx,
      );
    });
    const target = await this.storage.target(key, type, size, this.uploadTtl);
    return { mediaId: id, ...target };
  }
  async register(owner: string, id: string, productId?: string) {
    if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const found =
      await sql<MediaRow>`SELECT owner_id,purpose,object_key,content_type,size_bytes::text,state,expires_at FROM catalog_media WHERE id=${id}::uuid AND owner_id=${owner}::uuid AND state='PENDING' AND expires_at>clock_timestamp()`.execute(
        this.db,
      );
    const media = found.rows[0];
    if (!media || (media.purpose === 'PRODUCT_IMAGE') !== Boolean(productId))
      throw new Error('MEDIA_NOT_FOUND');
    const meta = await this.storage.inspect(media.object_key);
    if (meta.size.toString() !== media.size_bytes || meta.type !== media.content_type)
      throw new Error('INVALID_MEDIA');
    const final = `${media.purpose === 'PRODUCT_IMAGE' ? 'public' : 'private'}/${id}/${uuidV7()}`;
    await sql`INSERT INTO media_orphan_objects(object_key,remove_after) VALUES(${final},clock_timestamp()+interval '10 minutes')`.execute(
      this.db,
    );
    await this.storage.promote(media.object_key, final, meta.etag);
    try {
      if (media.purpose === 'PRODUCT_IMAGE') {
        const stream = await this.storage.open(final);
        let first = Buffer.alloc(0);
        for await (const chunk of stream) {
          first = Buffer.concat([first, Buffer.from(chunk as Uint8Array)]);
          if (first.length >= 12) break;
        }
        if (!validMediaMagic(media.content_type, first)) throw new Error('INVALID_MEDIA');
      }
      await this.db.transaction().execute(async (tx) => {
        if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN'], tx)))
          throw new Error('FORBIDDEN');
        if (productId) {
          const p =
            await sql`SELECT id FROM catalog_products WHERE id=${productId}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
              tx,
            );
          if (!p.rows.length) throw new Error('RESOURCE_NOT_FOUND');
        }
        const result =
          await sql`UPDATE catalog_media SET object_key=${final},state='REGISTERED',registered_at=clock_timestamp() WHERE id=${id}::uuid AND owner_id=${owner}::uuid AND state='PENDING' AND expires_at>clock_timestamp() AND object_key=${media.object_key} RETURNING id`.execute(
            tx,
          );
        if (!result.rows.length) throw new Error('MEDIA_NOT_FOUND');
        const promotion =
          await sql`DELETE FROM media_orphan_objects WHERE object_key=${final} AND lease_token IS NULL RETURNING object_key`.execute(
            tx,
          );
        if (!promotion.rows.length) throw new Error('MEDIA_NOT_FOUND');
        if (productId)
          await sql`INSERT INTO catalog_product_images(product_id,media_id) VALUES(${productId}::uuid,${id}::uuid)`.execute(
            tx,
          );
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${owner}::uuid,'MEDIA_REGISTERED','catalog_media',${id})`.execute(
          tx,
        );
      });
    } catch (error) {
      // A commit response can be lost after the transaction actually committed.
      // Never delete an object when the database cannot confirm it is unreferenced.
      const referenced = await sql`SELECT id FROM catalog_media WHERE object_key=${final}`
        .execute(this.db)
        .catch(() => null);
      if (referenced && !referenced.rows.length)
        await this.storage.remove(final).catch(() => undefined);
      throw error;
    }
    // The durable cleanup queue removes the staging object after its capability expires.
  }
  async publicRead(id: string) {
    const found = await sql<{
      object_key: string;
      content_type: string;
    }>`SELECT object_key,content_type FROM catalog_media WHERE id=${id}::uuid AND purpose='PRODUCT_IMAGE' AND state='REGISTERED'`.execute(
      this.db,
    );
    if (!found.rows[0] || !found.rows[0].object_key.startsWith('public/'))
      throw new Error('MEDIA_NOT_FOUND');
    return {
      body: await this.storage.open(found.rows[0].object_key),
      contentType: found.rows[0].content_type,
    };
  }
}
