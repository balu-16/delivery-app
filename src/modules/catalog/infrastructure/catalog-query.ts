import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import type { Database } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { SearchPort } from '../contracts/search.js';
import type { CatalogQuery, CatalogReadResult, CatalogPageOptions } from '../contracts/catalog.js';
import { cursorScope, decodeCursor, encodeCursor, type CursorRow } from './catalog-cursor.js';
import {
  availability,
  expandSynonyms,
  normalizeSearch,
  normalizeName,
  synonymPhrases,
} from '../domain/catalog.js';
interface Row extends CursorRow {
  product_id: string;
  name: string;
  description: string;
  category_id: string;
  brand_id: string | null;
  variant_id: string;
  variant_name: string;
  sku: string;
  selling_paise: string;
  mrp_paise: string;
  on_hand: string;
  reserved: string;
  popularity: number;
  images: Array<{ id: string; key: string }>;
}
export class PostgresCatalogQuery implements CatalogQuery, SearchPort {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly cdnBase?: string,
    private readonly redis?: Redis,
  ) {}
  async indexProduct(productId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const result = await sql<{
        name: string;
        normalized_name: string;
      }>`SELECT name,normalized_name FROM catalog_products WHERE id=${productId}::uuid AND deleted_at IS NULL FOR UPDATE`.execute(
        tx,
      );
      if (!result.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (result.rows[0].normalized_name === normalizeName(result.rows[0].name)) return;
      await sql`UPDATE catalog_products SET normalized_name=${normalizeName(result.rows[0].name)} WHERE id=${productId}::uuid`.execute(
        tx,
      );
    });
  }
  searchProducts(
    userId: string,
    addressId: string | undefined,
    query: string,
    page?: CatalogPageOptions,
  ) {
    return this.list(userId, addressId, { q: query, ...page });
  }
  suggest(userId: string, addressId: string | undefined, query: string, page?: CatalogPageOptions) {
    return this.list(userId, addressId, { q: query, suggest: true, ...page });
  }
  async list(
    user: string,
    address: string | undefined,
    options: CatalogPageOptions & {
      category?: string;
      product?: string;
      q?: string;
      suggest?: boolean;
    },
  ): Promise<CatalogReadResult> {
    const q = options.q === undefined ? null : normalizeSearch(options.q);
    const selected = await sql<{
      store_id: string;
    }>`SELECT z.store_id FROM addresses a JOIN LATERAL (
      SELECT z.store_id FROM zones z JOIN stores s ON s.id=z.store_id WHERE z.active AND ST_Covers(z.polygon,a.point::geometry)
      ORDER BY z.priority DESC,ST_Distance(s.location,a.point),s.id,z.id LIMIT 1
    ) z ON true WHERE a.user_id=${user}::uuid AND (${address ?? null}::uuid IS NOT NULL AND a.id=${address ?? null}::uuid OR ${address ?? null}::uuid IS NULL AND a.is_default) AND a.deleted_at IS NULL`.execute(
      this.db,
    );
    if (!selected.rows[0]) throw new Error('ADDRESS_NOT_SERVICEABLE');
    const store = selected.rows[0].store_id;
    const limit = options.limit ?? (options.suggest ? 10 : 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const scope = cursorScope([
      store,
      q,
      options.category ?? null,
      options.product ?? null,
      options.suggest ?? false,
    ]);
    const cursor = decodeCursor(options.cursor, scope);
    if (q === '')
      return {
        items: [],
        nextCursor: null,
        etag: `"${createHash('sha256')
          .update(store + ':empty')
          .digest('base64url')}"`,
      };
    const threshold = await this.config.get('catalogLowStockThreshold');
    const maxPerOrder = await this.config.get('catalogMaxPerOrder');
    let cacheKey: string | undefined,
      cacheSeconds = 0;
    const cacheStarted = performance.now();
    if (options.suggest && this.redis) {
      const ttl = await this.config.get('catalogSuggestCacheSeconds');
      const metadata = await sql<{
        revision: string;
        seconds: number | null;
      }>`SELECT revision::text,
        (SELECT extract(epoch FROM (min(boundary)-statement_timestamp()))::float8 FROM (
          SELECT valid_from AS boundary FROM catalog_prices WHERE store_id=${store}::uuid AND valid_from>statement_timestamp()
          UNION ALL SELECT valid_to FROM catalog_prices WHERE store_id=${store}::uuid AND valid_to>statement_timestamp()
          UNION ALL SELECT next_change FROM inventory_saleable_availability WHERE store_id=${store}::uuid AND next_change>statement_timestamp()
        ) future) AS seconds FROM catalog_revision WHERE singleton`.execute(this.db);
      const meta = metadata.rows[0];
      if (meta) {
        cacheSeconds = Math.max(
          0,
          Math.min(ttl, meta.seconds === null ? ttl : Math.floor(meta.seconds) - 1),
        );
        const digest = createHash('sha256')
          .update(
            JSON.stringify([
              store,
              q,
              options.category ?? null,
              options.product ?? null,
              meta.revision,
              threshold,
              maxPerOrder,
              this.cdnBase ?? null,
              options.cursor ?? null,
              limit,
            ]),
          )
          .digest('hex');
        cacheKey = `delivery:catalog:suggest:${digest}`;
        if (cacheSeconds > 0) {
          const cached = await this.redis.get(cacheKey).catch(() => null);
          if (cached) {
            try {
              const value = JSON.parse(cached) as CatalogReadResult;
              if (
                Array.isArray(value.items) &&
                typeof value.etag === 'string' &&
                (value.nextCursor === null || typeof value.nextCursor === 'string')
              )
                return value;
            } catch {
              /* treat corrupt cache as a miss */
            }
          }
        }
      }
    }
    const synonym = q
      ? await sql<{
          term: string;
          expansion: string;
        }>`SELECT term,expansion FROM catalog_synonyms WHERE term=ANY(${synonymPhrases(q)}::text[])`.execute(
          this.db,
        )
      : { rows: [] };
    const expanded = q ? expandSynonyms(q, synonym.rows) : q;
    const rows =
      await sql<Row>`WITH ranked AS (SELECT p.id AS product_id,p.normalized_name AS sort_name,p.name,p.description,p.category_id,p.brand_id,v.id AS variant_id,v.name AS variant_name,v.sku,
      price.selling_paise::text,price.mrp_paise::text,COALESCE(a.available,0)::text AS on_hand,'0'::text AS reserved,p.popularity,
      CASE WHEN COALESCE(a.available,0)<=0 THEN 1 ELSE 0 END AS stock_rank,
      CASE WHEN p.normalized_name=${q} THEN 0 WHEN p.normalized_name=${expanded} THEN 1 WHEN left(p.normalized_name,length(${q}))=${q} THEN 2 WHEN left(p.normalized_name,length(${expanded}))=${expanded} THEN 3 WHEN to_tsvector('simple',p.normalized_name) @@ plainto_tsquery('simple',coalesce(${expanded},'')) THEN 4 ELSE 5 END AS match_rank,
      -(CASE WHEN length(coalesce(${q},''))>=3 THEN floor(similarity(p.normalized_name,coalesce(${expanded},''))*1000000)::integer ELSE 0 END) AS similarity_rank,
      -p.popularity AS popularity_rank,
      COALESCE((SELECT json_agg(json_build_object('id',m.id,'key',m.object_key) ORDER BY im.position,m.id) FROM catalog_product_images im JOIN catalog_media m ON m.id=im.media_id WHERE im.product_id=p.id AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE'),'[]'::json) AS images
      FROM catalog_products p JOIN catalog_categories c ON c.id=p.category_id AND c.deleted_at IS NULL
      LEFT JOIN catalog_brands b ON b.id=p.brand_id
      JOIN catalog_variants v ON v.product_id=p.id AND v.deleted_at IS NULL
      JOIN store_inventory i ON i.variant_id=v.id AND i.store_id=${store}::uuid
      LEFT JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id
      JOIN LATERAL (SELECT selling_paise,mrp_paise FROM catalog_prices cp WHERE cp.store_id=i.store_id AND cp.variant_id=i.variant_id AND cp.valid_from<=statement_timestamp() AND (cp.valid_to IS NULL OR cp.valid_to>statement_timestamp()) LIMIT 1) price ON true
      WHERE p.published AND p.deleted_at IS NULL AND (p.brand_id IS NULL OR b.deleted_at IS NULL)
      AND (${options.category ?? null}::uuid IS NULL OR p.category_id=${options.category ?? null}::uuid)
      AND (${options.product ?? null}::uuid IS NULL OR p.id=${options.product ?? null}::uuid)
      AND (${q}::text IS NULL OR ${q}='' OR p.normalized_name=${q} OR p.normalized_name=${expanded}
        OR left(p.normalized_name,length(${q}))=${q} OR left(p.normalized_name,length(${expanded}))=${expanded}
        OR (length(${q})>=3 AND (to_tsvector('simple',p.normalized_name) @@ plainto_tsquery('simple',${expanded}) OR similarity(p.normalized_name,${expanded})>=0.3)))
      ) SELECT * FROM ranked WHERE (${cursor === null} OR (stock_rank,match_rank,similarity_rank,popularity_rank,sort_name,product_id,variant_id)>(${cursor?.[0] ?? 0},${cursor?.[1] ?? 0},${cursor?.[2] ?? 0},${cursor?.[3] ?? 0},${cursor?.[4] ?? ''},${cursor?.[5] ?? '00000000-0000-0000-0000-000000000000'}::uuid,${cursor?.[6] ?? '00000000-0000-0000-0000-000000000000'}::uuid))
      ORDER BY stock_rank,match_rank,similarity_rank,popularity_rank,sort_name,product_id,variant_id LIMIT ${limit + 1}`.execute(
        this.db,
      );
    const selectedRows = rows.rows.slice(0, limit);
    const nextCursor = rows.rows.length > limit ? encodeCursor(scope, selectedRows.at(-1)!) : null;
    const items = selectedRows.map((row) => ({
      productId: row.product_id,
      name: row.name,
      description: row.description,
      categoryId: row.category_id,
      brandId: row.brand_id,
      variantId: row.variant_id,
      variantName: row.variant_name,
      sku: row.sku,
      sellingPaise: row.selling_paise,
      mrpPaise: row.mrp_paise,
      discountPercent:
        BigInt(row.mrp_paise) === 0n
          ? 0
          : Number(
              ((BigInt(row.mrp_paise) - BigInt(row.selling_paise)) * 100n) / BigInt(row.mrp_paise),
            ),
      ...availability(row.on_hand, row.reserved, threshold),
      maxPerOrder,
      images: row.images.map((image) =>
        this.cdnBase ? `${this.cdnBase.replace(/\/$/, '')}/${image.key}` : `/media/${image.id}`,
      ),
    }));
    const etag = `"${createHash('sha256')
      .update(JSON.stringify([store, items, nextCursor]))
      .digest('base64url')}"`;
    const result = { items, nextCursor, etag };
    const remaining = cacheSeconds - Math.ceil((performance.now() - cacheStarted) / 1000);
    if (cacheKey && this.redis && remaining > 0)
      await this.redis
        .set(cacheKey, JSON.stringify(result), 'EX', remaining)
        .catch(() => undefined);
    return result;
  }
}
