import { sql } from 'kysely';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { transition } from '../../../common/state-machine/state-machine.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { ApprovalFactory, ApprovalExecutor } from '../../compliance/contracts/approval.js';
import type { Json } from '../../../platform/database/database.js';
import type { CatalogAdmin, PriceDraft } from '../contracts/catalog.js';
import { assertMoney, normalizeSearch } from '../domain/catalog.js';
import { CatalogWrite } from './catalog-write.js';

function pricePayload(value: Json): value is { [key: string]: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    ['storeId', 'variantId', 'sellingPaise', 'mrpPaise'].every(
      (k) => typeof value[k] === 'string',
    ) &&
    (value.validFrom === null || typeof value.validFrom === 'string') &&
    (value.validTo === null || typeof value.validTo === 'string')
  );
}
export class PostgresCatalogAdmin extends CatalogWrite implements CatalogAdmin {
  readonly approvals: ApprovalExecutor;
  constructor(db: Database, identity: IdentityAccess, config: AppConfig, factory: ApprovalFactory) {
    super(db, identity, config);
    const action = (makerRole: 'SUPER_ADMIN') => ({
      version: 1,
      makerRole,
      checkerRole: 'SUPER_ADMIN',
      ttlSeconds: 86400,
      validate: pricePayload,
      execute: async (tx: TransactionContext, payload: Json, _key: string, checker: string) => {
        if (!pricePayload(payload)) throw new Error('INVALID_APPROVAL');
        await this.writePrice(tx, payload as unknown as PriceDraft, checker, true);
      },
    });
    this.approvals = factory.create({
      CATALOG_PRICE_CHANGE: action('SUPER_ADMIN'),
      CATALOG_PRICE_CHANGE_SUPER: action('SUPER_ADMIN'),
    });
  }
  approve(actor: string, requestId: string): Promise<void> {
    return this.approvals.approve(actor, requestId);
  }
  remove(
    actor: string,
    kind: 'categories' | 'brands' | 'products' | 'variants',
    id: string,
  ): Promise<void> {
    return this.mutate(actor, 'CATALOG_DELETED', id, async (tx) => {
      if (kind === 'categories' || kind === 'brands') {
        if (kind === 'categories')
          await sql`SELECT id FROM catalog_categories WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
        else await sql`SELECT id FROM catalog_brands WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
        const use =
          kind === 'categories'
            ? await sql`SELECT id FROM catalog_products WHERE category_id=${id}::uuid AND published AND deleted_at IS NULL LIMIT 1`.execute(
                tx,
              )
            : await sql`SELECT id FROM catalog_products WHERE brand_id=${id}::uuid AND published AND deleted_at IS NULL LIMIT 1`.execute(
                tx,
              );
        if (use.rows.length) throw new Error('CATALOG_IN_USE');
      }
      if (kind === 'variants') {
        const parent = await sql<{
          product_id: string;
        }>`SELECT product_id FROM catalog_variants WHERE id=${id}::uuid AND deleted_at IS NULL`.execute(
          tx,
        );
        if (!parent.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
        await sql`SELECT id FROM catalog_products WHERE id=${parent.rows[0].product_id}::uuid FOR UPDATE`.execute(
          tx,
        );
      }
      if (kind === 'products') {
        const product = await sql<{
          published: boolean;
        }>`SELECT published FROM catalog_products WHERE id=${id}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
          tx,
        );
        if (!product.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
        if (product.rows[0].published) await this.recordPublication(tx, id, actor, true, false);
      }
      const result =
        kind === 'categories'
          ? await sql`UPDATE catalog_categories SET deleted_at=clock_timestamp() WHERE id=${id}::uuid AND deleted_at IS NULL RETURNING id`.execute(
              tx,
            )
          : kind === 'brands'
            ? await sql`UPDATE catalog_brands SET deleted_at=clock_timestamp() WHERE id=${id}::uuid AND deleted_at IS NULL RETURNING id`.execute(
                tx,
              )
            : kind === 'products'
              ? await sql`UPDATE catalog_products SET deleted_at=clock_timestamp(),published=false WHERE id=${id}::uuid AND deleted_at IS NULL RETURNING id`.execute(
                  tx,
                )
              : await sql`UPDATE catalog_variants SET deleted_at=clock_timestamp() WHERE id=${id}::uuid AND deleted_at IS NULL RETURNING product_id`.execute(
                  tx,
                );
      if (!result.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      if (kind === 'variants') {
        const p = result.rows[0] as { product_id: string };
        const published = await sql<{
          published: boolean;
        }>`SELECT published FROM catalog_products WHERE id=${p.product_id}::uuid`.execute(tx);
        if (published.rows[0]?.published) await this.assertPublishable(tx, p.product_id);
      }
    });
  }
  publish(actor: string, id: string, published: boolean): Promise<void> {
    return this.mutate(
      actor,
      published ? 'PRODUCT_PUBLISHED' : 'PRODUCT_UNPUBLISHED',
      id,
      async (tx) => {
        const p = await sql<{
          published: boolean;
        }>`SELECT published FROM catalog_products WHERE id=${id}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
          tx,
        );
        if (!p.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
        if (p.rows[0].published === published) return;
        if (published) await this.assertPublishable(tx, id);
        await this.recordPublication(tx, id, actor, p.rows[0].published, published);
      },
    );
  }
  private async recordPublication(
    tx: TransactionContext,
    id: string,
    actor: string,
    previous: boolean,
    published: boolean,
  ): Promise<void> {
    const state = transition(previous ? 'PUBLISHED' : 'DRAFT', published ? 'PUBLISHED' : 'DRAFT', {
      DRAFT: ['PUBLISHED'],
      PUBLISHED: ['DRAFT'],
    });
    const changed = await sql<{
      version: string;
      occurred_at: Date;
    }>`UPDATE catalog_products SET published=${state === 'PUBLISHED'},publication_version=publication_version+1,updated_at=clock_timestamp() WHERE id=${id}::uuid RETURNING publication_version::text AS version,updated_at AS occurred_at`.execute(
      tx,
    );
    const row = changed.rows[0]!;
    await sql`INSERT INTO catalog_publication_history(product_id,version,previous_published,published,actor_id,occurred_at) VALUES(${id}::uuid,${row.version}::bigint,${previous},${published},${actor}::uuid,${row.occurred_at})`.execute(
      tx,
    );
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType: 'catalog.product_publication_changed',
        schemaVersion: 1,
        aggregateType: 'catalog_product',
        aggregateId: id,
        aggregateVersion: row.version,
        occurredAt: row.occurred_at.toISOString(),
        correlationId: uuidV7(),
        causationId: null,
        payload: { previous, published, actorId: actor },
      },
      [],
    );
  }
  setAssortment(actor: string, store: string, variant: string, active = true): Promise<void> {
    return this.mutate(actor, 'ASSORTMENT_CHANGED', variant, async (tx) => {
      // Same store/variant row locks as the reservation path (lockStock order).
      await sql`SELECT id FROM stores WHERE id=${store}::uuid FOR SHARE`.execute(tx);
      await sql`SELECT id FROM catalog_variants WHERE id=${variant}::uuid FOR SHARE`.execute(tx);
      const locked = await sql<{
        listed: boolean;
      }>`SELECT listed FROM store_inventory WHERE store_id=${store}::uuid AND variant_id=${variant}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (locked.rows.length) {
        if (locked.rows[0]!.listed === active) return; // idempotent no-op
        await sql`UPDATE store_inventory SET listed=${active} WHERE store_id=${store}::uuid AND variant_id=${variant}::uuid`.execute(
          tx,
        );
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'ASSORTMENT_LISTING_CHANGED','catalog',${variant},${JSON.stringify({ storeId: store, variantId: variant, listed: active })}::jsonb)`.execute(
          tx,
        );
        return;
      }
      if (!active) return; // withdrawing a missing pair is a no-op
      const storeCheck = await sql<{
        id: string;
      }>`SELECT id FROM stores WHERE id=${store}::uuid`.execute(tx);
      const variantCheck = await sql<{
        id: string;
      }>`SELECT id FROM catalog_variants WHERE id=${variant}::uuid AND deleted_at IS NULL`.execute(
        tx,
      );
      if (!storeCheck.rows.length || !variantCheck.rows.length)
        throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO store_inventory(store_id,variant_id,listed) VALUES(${store}::uuid,${variant}::uuid,true) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'ASSORTMENT_LISTING_CHANGED','catalog',${variant},${JSON.stringify({ storeId: store, variantId: variant, listed: true })}::jsonb)`.execute(
        tx,
      );
    });
  }
  async listAssortment(
    actor: string,
    variantId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{
    items: Array<{ storeId: string; storeName: string; listed: boolean }>;
    nextCursor: string | null;
  }> {
    if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const variant = await sql<{
      id: string;
    }>`SELECT id FROM catalog_variants WHERE id=${variantId}::uuid AND deleted_at IS NULL`.execute(
      this.db,
    );
    if (!variant.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    const result = await sql<{
      store_id: string;
      store_name: string;
      listed: boolean;
    }>`SELECT s.id::text AS store_id,s.name AS store_name,COALESCE(i.listed,true) AS listed FROM stores s LEFT JOIN store_inventory i ON i.store_id=s.id AND i.variant_id=${variantId}::uuid WHERE (${cursor ?? null}::uuid IS NULL OR s.id>${cursor ?? null}::uuid) ORDER BY s.id LIMIT ${limit + 1}`.execute(
      this.db,
    );
    const items = result.rows.slice(0, limit).map((r) => ({
      storeId: r.store_id,
      storeName: r.store_name,
      listed: r.listed,
    }));
    return { items, nextCursor: result.rows.length > limit ? items.at(-1)!.storeId : null };
  }
  async listImages(
    actor: string,
    productId: string,
  ): Promise<{
    items: Array<{ mediaId: string; url: string; position: number }>;
    revision: string;
  }> {
    if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const product = await sql<{
      image_revision: string;
    }>`SELECT image_revision::text AS image_revision FROM catalog_products WHERE id=${productId}::uuid AND deleted_at IS NULL`.execute(
      this.db,
    );
    if (!product.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    const rows = await sql<{
      media_id: string;
      position: number;
    }>`SELECT im.media_id::text AS media_id,im.position FROM catalog_product_images im JOIN catalog_media m ON m.id=im.media_id WHERE im.product_id=${productId}::uuid AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE' ORDER BY im.position,im.media_id`.execute(
      this.db,
    );
    return {
      items: rows.rows.map((r) => ({
        mediaId: r.media_id,
        url: `/media/${r.media_id}`,
        position: r.position,
      })),
      revision: product.rows[0]!.image_revision,
    };
  }
  async replaceImages(
    actor: string,
    productId: string,
    mediaIds: string[],
    expectedRevision: string,
  ): Promise<{
    items: Array<{ mediaId: string; url: string; position: number }>;
    revision: string;
  }> {
    if (!Array.isArray(mediaIds) || mediaIds.length > 20) throw new Error('INVALID_MEDIA');
    if (new Set(mediaIds).size !== mediaIds.length) throw new Error('INVALID_MEDIA');
    return this.mutate(actor, 'CATALOG_IMAGES_CHANGED', productId, async (tx) => {
      const product = await sql<{
        published: boolean;
        image_revision: string;
      }>`SELECT published,image_revision::text AS image_revision FROM catalog_products WHERE id=${productId}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
        tx,
      );
      if (!product.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      if (product.rows[0]!.image_revision !== expectedRevision)
        throw new Error('CONCURRENT_MODIFICATION');
      if (product.rows[0]!.published && mediaIds.length === 0)
        throw new Error('PRODUCT_NOT_PUBLISHABLE');
      if (mediaIds.length) {
        const registered = await sql<{
          media_id: string;
        }>`SELECT im.media_id::text AS media_id FROM catalog_product_images im JOIN catalog_media m ON m.id=im.media_id WHERE im.product_id=${productId}::uuid AND im.media_id=ANY(${mediaIds}::uuid[]) AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE'`.execute(
          tx,
        );
        if (registered.rows.length !== mediaIds.length) throw new Error('MEDIA_NOT_FOUND');
      }
      await sql`DELETE FROM catalog_product_images WHERE product_id=${productId}::uuid`.execute(tx);
      for (let i = 0; i < mediaIds.length; i++) {
        await sql`INSERT INTO catalog_product_images(product_id,media_id,position) VALUES(${productId}::uuid,${mediaIds[i]!}::uuid,${i})`.execute(
          tx,
        );
      }
      const bumped = await sql<{
        image_revision: string;
      }>`UPDATE catalog_products SET image_revision=image_revision+1 WHERE id=${productId}::uuid RETURNING image_revision::text AS image_revision`.execute(
        tx,
      );
      return this.listImagesInTx(tx, productId, bumped.rows[0]!.image_revision);
    });
  }
  private async listImagesInTx(
    tx: TransactionContext,
    productId: string,
    revision: string,
  ): Promise<{
    items: Array<{ mediaId: string; url: string; position: number }>;
    revision: string;
  }> {
    const rows = await sql<{
      media_id: string;
      position: number;
    }>`SELECT im.media_id::text AS media_id,im.position FROM catalog_product_images im JOIN catalog_media m ON m.id=im.media_id WHERE im.product_id=${productId}::uuid AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE' ORDER BY im.position,im.media_id`.execute(
      tx,
    );
    return {
      items: rows.rows.map((r) => ({
        mediaId: r.media_id,
        url: `/media/${r.media_id}`,
        position: r.position,
      })),
      revision,
    };
  }
  synonym(actor: string, term: string, expansion: string | null): Promise<void> {
    const key = normalizeSearch(term),
      value = expansion === null ? null : normalizeSearch(expansion);
    if (!key || (value !== null && !value)) throw new Error('INVALID_SEARCH_QUERY');
    return this.mutate(actor, 'CATALOG_SYNONYM_CHANGED', key, async (tx) => {
      if (value === null) await sql`DELETE FROM catalog_synonyms WHERE term=${key}`.execute(tx);
      else
        await sql`INSERT INTO catalog_synonyms(term,expansion) VALUES(${key},${value}) ON CONFLICT(term) DO UPDATE SET expansion=EXCLUDED.expansion`.execute(
          tx,
        );
    });
  }
  async setPrice(actor: string, data: PriceDraft): Promise<{ approvalId?: string }> {
    assertMoney(data.sellingPaise, data.mrpPaise);
    if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const previous = await sql<{
      selling_paise: string;
    }>`SELECT selling_paise::text FROM catalog_global_prices WHERE variant_id=${data.variantId}::uuid`.execute(
      this.db,
    );
    const old = previous.rows[0]?.selling_paise;
    const threshold = await this.config.get('catalogPriceApprovalPercent');
    if (
      old &&
      (BigInt(old) === 0n
        ? BigInt(data.sellingPaise) > 0n
        : (BigInt(data.sellingPaise) > BigInt(old)
            ? BigInt(data.sellingPaise) - BigInt(old)
            : BigInt(old) - BigInt(data.sellingPaise)) *
            100n >
          BigInt(old) * BigInt(threshold))
    ) {
      const payload = { ...data, validFrom: data.validFrom ?? null, validTo: data.validTo ?? null };
      const action = (await this.identity.hasRole(actor, ['SUPER_ADMIN']))
        ? 'CATALOG_PRICE_CHANGE'
        : 'CATALOG_PRICE_CHANGE_SUPER';
      return { approvalId: await this.approvals.request(actor, action, payload) };
    }
    await this.mutate(actor, 'CATALOG_PRICE_CHANGED', data.variantId, (tx) =>
      this.writePrice(tx, data, actor),
    );
    return {};
  }
  private async writePrice(
    tx: TransactionContext,
    data: PriceDraft,
    actor: string,
    approved = false,
  ): Promise<void> {
    assertMoney(data.sellingPaise, data.mrpPaise);
    const requested = data.validFrom ? new Date(data.validFrom) : null,
      to = data.validTo ? new Date(data.validTo) : null;
    if (
      (requested && !Number.isFinite(requested.getTime())) ||
      (to && (!Number.isFinite(to.getTime()) || (requested !== null && to <= requested)))
    )
      throw new Error('INVALID_PRICE');
    const locked =
      await sql`SELECT v.id FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.id=${data.variantId}::uuid AND v.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF p,v`.execute(
        tx,
      );
    if (!locked.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    // A price applies to the variant across all stores.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`price:${data.variantId}`},0))`.execute(
      tx,
    );
    if (!approved) {
      const current = await sql<{
        selling_paise: string;
      }>`SELECT selling_paise::text FROM catalog_global_prices WHERE variant_id=${data.variantId}::uuid`.execute(
        tx,
      );
      const old = current.rows[0]?.selling_paise;
      const threshold = await this.config.get('catalogPriceApprovalPercent');
      if (
        old &&
        (BigInt(old) === 0n
          ? BigInt(data.sellingPaise) > 0n
          : (BigInt(data.sellingPaise) > BigInt(old)
              ? BigInt(data.sellingPaise) - BigInt(old)
              : BigInt(old) - BigInt(data.sellingPaise)) *
              100n >
            BigInt(old) * BigInt(threshold))
      )
        throw new Error('APPROVAL_REQUIRED');
    }
    const clock = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
    const now = clock.rows[0]!.now;
    const from = requested && requested > now ? requested : now;
    if (to && to <= from) throw new Error('INVALID_PRICE_TIME');
    await sql`UPDATE catalog_prices SET valid_to=${from} WHERE store_id=${data.storeId}::uuid AND variant_id=${data.variantId}::uuid AND valid_from<${from} AND (valid_to IS NULL OR valid_to>${from})`.execute(
      tx,
    );
    await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,valid_to,created_by) VALUES(${uuidV7()}::uuid,${data.storeId}::uuid,${data.variantId}::uuid,${data.sellingPaise}::bigint,${data.mrpPaise}::bigint,${from},${to},${actor}::uuid)`.execute(
      tx,
    );
  }
}
