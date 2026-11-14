import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { ProductDraft, VariantDraft } from '../contracts/catalog.js';
import { normalizeName } from '../domain/catalog.js';

type Kind = 'categories' | 'brands' | 'products' | 'variants';
export class CatalogWrite {
  constructor(
    protected readonly db: Database,
    protected readonly identity: IdentityAccess,
    protected readonly config: AppConfig,
  ) {}
  protected async mutate<T>(
    actor: string,
    action: string,
    subject: string,
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const result = await work(tx);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()},${actor}::uuid,${action},'catalog',${subject})`.execute(
        tx,
      );
      return result;
    });
  }
  async list(
    actor: string,
    kind: Kind,
    limit: number,
    cursor?: string,
    id?: string,
    productId?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const after = cursor ?? null;
    const parentFilter =
      kind === 'variants' && productId ? sql` AND product_id=${productId}::uuid` : sql``;
    const result =
      kind === 'categories'
        ? await sql<{
            id: string;
          }>`SELECT id,name FROM catalog_categories WHERE deleted_at IS NULL AND (${id ?? null}::uuid IS NULL OR id=${id ?? null}::uuid) AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
            this.db,
          )
        : kind === 'brands'
          ? await sql<{
              id: string;
            }>`SELECT id,name FROM catalog_brands WHERE deleted_at IS NULL AND (${id ?? null}::uuid IS NULL OR id=${id ?? null}::uuid) AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
              this.db,
            )
          : kind === 'products'
            ? await sql<{
                id: string;
              }>`SELECT id,category_id AS "categoryId",brand_id AS "brandId",name,description,hsn_code AS "hsnCode",gst_rate_bps AS "gstRateBps",perishable,expiry_tracking AS "expiryTracking",published FROM catalog_products WHERE deleted_at IS NULL AND (${id ?? null}::uuid IS NULL OR id=${id ?? null}::uuid) AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
                this.db,
              )
            : await sql<{
                id: string;
              }>`SELECT id,product_id AS "productId",name,sku,barcode,base_unit AS "baseUnit" FROM catalog_variants WHERE deleted_at IS NULL AND (${id ?? null}::uuid IS NULL OR id=${id ?? null}::uuid) AND (${after}::uuid IS NULL OR id>${after}::uuid)${parentFilter} ORDER BY id LIMIT ${limit + 1}`.execute(
                this.db,
              );
    const items = result.rows.slice(0, limit);
    return { items, nextCursor: result.rows.length > limit ? items.at(-1)!.id : null };
  }
  async get(actor: string, kind: Kind, id: string): Promise<unknown> {
    const result = await this.list(actor, kind, 1, undefined, id);
    if (!result.items.length) throw new Error('RESOURCE_NOT_FOUND');
    return result.items[0];
  }
  async listSynonyms(
    actor: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: Array<{ term: string; expansion: string }>; nextCursor: string | null }> {
    if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      term: string;
      expansion: string;
    }>`SELECT term,expansion FROM catalog_synonyms WHERE (${cursor ?? null}::text IS NULL OR term>${cursor ?? null}) ORDER BY term LIMIT ${limit + 1}`.execute(
      this.db,
    );
    const items = rows.rows.slice(0, limit);
    return { items, nextCursor: rows.rows.length > limit ? items.at(-1)!.term : null };
  }
  saveNamed(
    actor: string,
    kind: 'categories' | 'brands',
    name: string,
    requestedId?: string,
  ): Promise<string> {
    const id = requestedId ?? uuidV7();
    if (!name.trim() || name.length > 200) throw new Error('INVALID_CATALOG');
    return this.mutate(actor, 'CATALOG_NAMED_SAVED', id, async (tx) => {
      const result =
        kind === 'categories'
          ? requestedId
            ? await sql`UPDATE catalog_categories SET name=${name.trim()},updated_at=clock_timestamp() WHERE id=${id}::uuid AND deleted_at IS NULL RETURNING id`.execute(
                tx,
              )
            : await sql`INSERT INTO catalog_categories(id,name) VALUES(${id}::uuid,${name.trim()}) RETURNING id`.execute(
                tx,
              )
          : requestedId
            ? await sql`UPDATE catalog_brands SET name=${name.trim()},updated_at=clock_timestamp() WHERE id=${id}::uuid AND deleted_at IS NULL RETURNING id`.execute(
                tx,
              )
            : await sql`INSERT INTO catalog_brands(id,name) VALUES(${id}::uuid,${name.trim()}) RETURNING id`.execute(
                tx,
              );
      if (!result.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      return id;
    });
  }
  saveProduct(actor: string, data: ProductDraft, requestedId?: string): Promise<string> {
    const id = requestedId ?? uuidV7();
    return this.mutate(actor, 'CATALOG_PRODUCT_SAVED', id, async (tx) => {
      if (!data.name.trim() || data.name.length > 200 || data.description.length > 5000)
        throw new Error('INVALID_CATALOG');
      if (
        data.gstRateBps != null &&
        !(await this.config.get('catalogAllowedGstBps')).includes(data.gstRateBps)
      )
        throw new Error('INVALID_GST');
      const existing = await sql<{
        published: boolean;
      }>`SELECT published FROM catalog_products WHERE id=${id}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
        tx,
      );
      if (requestedId && !existing.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await sql`SELECT id FROM catalog_categories WHERE id=${data.categoryId}::uuid FOR SHARE`.execute(
        tx,
      );
      if (data.brandId)
        await sql`SELECT id FROM catalog_brands WHERE id=${data.brandId}::uuid FOR SHARE`.execute(
          tx,
        );
      const refs = await sql<{
        ok: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM catalog_categories WHERE id=${data.categoryId}::uuid AND deleted_at IS NULL) AND (${data.brandId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM catalog_brands WHERE id=${data.brandId ?? null}::uuid AND deleted_at IS NULL)) AS ok`.execute(
        tx,
      );
      if (!refs.rows[0]?.ok) throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO catalog_products(id,category_id,brand_id,name,normalized_name,description,hsn_code,gst_rate_bps,perishable,expiry_tracking)
        VALUES(${id}::uuid,${data.categoryId}::uuid,${data.brandId ?? null}::uuid,${data.name.trim()},${normalizeName(data.name)},${data.description},${data.hsnCode ?? null},${data.gstRateBps ?? null},${data.perishable},${data.expiryTracking})
        ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,brand_id=EXCLUDED.brand_id,name=EXCLUDED.name,normalized_name=EXCLUDED.normalized_name,description=EXCLUDED.description,hsn_code=EXCLUDED.hsn_code,gst_rate_bps=EXCLUDED.gst_rate_bps,perishable=EXCLUDED.perishable,expiry_tracking=EXCLUDED.expiry_tracking,updated_at=clock_timestamp()`.execute(
        tx,
      );
      if (existing.rows[0]?.published) await this.assertPublishable(tx, id);
      return id;
    });
  }
  saveVariant(actor: string, data: VariantDraft, requestedId?: string): Promise<string> {
    const id = requestedId ?? uuidV7();
    return this.mutate(actor, 'CATALOG_VARIANT_SAVED', id, async (tx) => {
      if (
        !data.name.trim() ||
        !data.sku.trim() ||
        data.name.length > 200 ||
        data.sku.length > 100 ||
        (data.barcode?.length ?? 0) > 100 ||
        (data.baseUnit !== undefined && !['PIECE', 'GRAM', 'MILLILITRE'].includes(data.baseUnit))
      )
        throw new Error('INVALID_CATALOG');
      const parent =
        await sql`SELECT id FROM catalog_products WHERE id=${data.productId}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
          tx,
        );
      if (!parent.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      if (requestedId) {
        const old = await sql<{
          product_id: string;
          base_unit: string;
        }>`SELECT product_id,base_unit FROM catalog_variants WHERE id=${id}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
          tx,
        );
        if (!old.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
        if (old.rows[0].product_id !== data.productId) throw new Error('INVALID_CATALOG');
        if (data.baseUnit && data.baseUnit !== old.rows[0].base_unit)
          throw new Error('CATALOG_IN_USE');
      }
      await sql`INSERT INTO catalog_variants(id,product_id,name,sku,barcode,base_unit) VALUES(${id}::uuid,${data.productId}::uuid,${data.name.trim()},${data.sku.trim()},${data.barcode?.trim() || null},${data.baseUnit ?? 'PIECE'})
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sku=EXCLUDED.sku,barcode=EXCLUDED.barcode,updated_at=clock_timestamp()`.execute(
        tx,
      );
      return id;
    });
  }
  async assertPublishable(tx: TransactionContext, id: string): Promise<void> {
    await sql`SELECT c.id FROM catalog_categories c JOIN catalog_products p ON p.category_id=c.id WHERE p.id=${id}::uuid FOR SHARE OF c`.execute(
      tx,
    );
    await sql`SELECT b.id FROM catalog_brands b JOIN catalog_products p ON p.brand_id=b.id WHERE p.id=${id}::uuid FOR SHARE OF b`.execute(
      tx,
    );
    const row = await sql<{
      hsn_code: string | null;
      gst_rate_bps: number | null;
      perishable: boolean;
      expiry_tracking: boolean;
      ok: boolean;
    }>`SELECT p.hsn_code,p.gst_rate_bps,p.perishable,p.expiry_tracking,
      EXISTS(SELECT 1 FROM catalog_variants v WHERE v.product_id=p.id AND v.deleted_at IS NULL) AND
      EXISTS(SELECT 1 FROM catalog_product_images i JOIN catalog_media m ON m.id=i.media_id WHERE i.product_id=p.id AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE') AND
      EXISTS(SELECT 1 FROM catalog_categories c WHERE c.id=p.category_id AND c.deleted_at IS NULL) AND
      (p.brand_id IS NULL OR EXISTS(SELECT 1 FROM catalog_brands b WHERE b.id=p.brand_id AND b.deleted_at IS NULL)) AS ok FROM catalog_products p WHERE p.id=${id}::uuid AND p.deleted_at IS NULL`.execute(
      tx,
    );
    const p = row.rows[0];
    if (
      !p ||
      !p.ok ||
      !p.hsn_code?.trim() ||
      p.gst_rate_bps == null ||
      !(await this.config.get('catalogAllowedGstBps')).includes(p.gst_rate_bps) ||
      (p.perishable && !p.expiry_tracking)
    )
      throw new Error('PRODUCT_NOT_PUBLISHABLE');
  }
}
