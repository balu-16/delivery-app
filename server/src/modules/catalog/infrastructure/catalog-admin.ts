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
  setAssortment(actor: string, store: string, variant: string): Promise<void> {
    return this.mutate(actor, 'ASSORTMENT_ADDED', variant, async (tx) => {
      await sql`INSERT INTO store_inventory(store_id,variant_id) VALUES(${store}::uuid,${variant}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
    });
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
    }>`SELECT selling_paise::text FROM catalog_prices WHERE store_id=${data.storeId}::uuid AND variant_id=${data.variantId}::uuid AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())`.execute(
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
    // Serializes all changes to a variant/store, including the first price.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${data.storeId}:${data.variantId}`},0))`.execute(
      tx,
    );
    if (!approved) {
      const current = await sql<{
        selling_paise: string;
      }>`SELECT selling_paise::text FROM catalog_prices WHERE store_id=${data.storeId}::uuid AND variant_id=${data.variantId}::uuid AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())`.execute(
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
