import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { transactionWithRetry } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type {
  CouponAdminView,
  CouponAdministration,
  CouponDraft,
  CouponPatch,
} from '../contracts/coupons.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import {
  normalizeCode,
  parseCouponDraft,
  parseCouponPatch,
  parseCouponValue,
} from '../domain/coupon-policy.js';
import { couponColumns, insertAudit, type CouponRow } from './coupon-rows.js';

function view(row: CouponRow): CouponAdminView {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    valuePaise: row.value,
    maxCapPaise: row.max_cap_paise,
    minOrderPaise: row.min_order_paise,
    perUserLimit: row.per_user_limit,
    globalLimit: row.global_limit,
    redeemedCount: row.redeemed_count,
    validFrom: row.valid_from ? new Date(row.valid_from).toISOString() : null,
    validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
    storeId: row.store_id,
    categoryId: row.category_id,
    productId: row.product_id,
    excludedVariantIds: row.excluded_variant_ids,
    stackable: row.stackable,
    firstOrderOnly: row.first_order_only,
    active: row.active,
    version: row.version,
  };
}
/** Plain ADMIN authority is sufficient for basic coupon management in P5; every change is audited. */
export class PostgresCouponAdministration implements CouponAdministration {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}
  private async requireAdmin(actorId: string): Promise<void> {
    if (!(await this.identity.hasRole(actorId, ['ADMIN', 'SUPER_ADMIN'])))
      throw new Error('FORBIDDEN');
  }
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async create(
    actorId: string,
    draft: CouponDraft,
    tx?: TransactionContext,
  ): Promise<CouponAdminView> {
    parseCouponDraft(draft);
    await this.requireAdmin(actorId);
    const value = parseCouponValue(draft.kind, draft.valuePaise);
    return this.run(tx, async (executor) => {
      const id = uuidV7();
      const inserted =
        await sql<CouponRow>`INSERT INTO coupons(id,code,kind,value,max_cap_paise,min_order_paise,per_user_limit,global_limit,
        valid_from,valid_to,store_id,category_id,product_id,excluded_variant_ids,stackable,first_order_only,created_by)
        VALUES(${id}::uuid,${normalizeCode(draft.code)},${draft.kind},${value.toString()}::bigint,
        ${draft.maxCapPaise}::bigint,${draft.minOrderPaise}::bigint,${draft.perUserLimit},${draft.globalLimit},
        ${draft.validFrom},${draft.validTo},${draft.storeId}::uuid,${draft.categoryId}::uuid,${draft.productId}::uuid,
        ${draft.excludedVariantIds}::uuid[],${draft.stackable},${draft.firstOrderOnly},${actorId}::uuid)
        RETURNING ${couponColumns}`.execute(executor);
      const row = inserted.rows[0]!;
      await insertAudit(executor, actorId, 'COUPON_CREATED', id, { after: view(row) });
      return view(row);
    });
  }
  async list(
    actorId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: CouponAdminView[]; nextCursor: string | null }> {
    await this.requireAdmin(actorId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    if (cursor !== undefined && !/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(cursor))
      throw new Error('INVALID_PAGE');
    const rows = await sql<CouponRow>`SELECT ${couponColumns} FROM coupons
      ${cursor === undefined ? sql`` : sql`WHERE code > ${cursor}`}
      ORDER BY code LIMIT ${limit + 1}`.execute(this.db);
    const items = rows.rows.slice(0, limit).map(view);
    return {
      items,
      nextCursor: rows.rows.length > limit ? items.at(-1)!.code : null,
    };
  }
  async update(
    actorId: string,
    id: string,
    patch: CouponPatch,
    expectedVersion: string,
    tx?: TransactionContext,
  ): Promise<CouponAdminView> {
    const parsed = parseCouponPatch(patch);
    await this.requireAdmin(actorId);
    if (!/^[0-9]+$/.test(expectedVersion)) throw new Error('INVALID_INPUT');
    return this.run(tx, async (executor) => {
      const locked =
        await sql<CouponRow>`SELECT ${couponColumns} FROM coupons WHERE id=${id}::uuid FOR UPDATE`.execute(
          executor,
        );
      const row = locked.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.version !== expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
      if (parsed.globalLimit != null && parsed.globalLimit < row.redeemed_count)
        throw new Error('INVALID_INPUT');
      const updated = await sql<CouponRow>`UPDATE coupons SET
        per_user_limit=${parsed.perUserLimit === undefined ? row.per_user_limit : parsed.perUserLimit},
        global_limit=${parsed.globalLimit === undefined ? row.global_limit : parsed.globalLimit},
        min_order_paise=${parsed.minOrderPaise === undefined ? row.min_order_paise : parsed.minOrderPaise}::bigint,
        valid_from=${parsed.validFrom === undefined ? row.valid_from : parsed.validFrom},
        valid_to=${parsed.validTo === undefined ? row.valid_to : parsed.validTo},
        active=${parsed.active === undefined ? row.active : parsed.active},
        version=version+1,updated_at=clock_timestamp()
        WHERE id=${id}::uuid AND version=${expectedVersion}::bigint
        RETURNING ${couponColumns}`.execute(executor);
      const next = updated.rows[0]!;
      await insertAudit(executor, actorId, 'COUPON_UPDATED', id, {
        before: {
          perUserLimit: row.per_user_limit,
          globalLimit: row.global_limit,
          minOrderPaise: row.min_order_paise,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          active: row.active,
          version: row.version,
        },
        after: {
          perUserLimit: next.per_user_limit,
          globalLimit: next.global_limit,
          minOrderPaise: next.min_order_paise,
          validFrom: next.valid_from,
          validTo: next.valid_to,
          active: next.active,
          version: next.version,
        },
      });
      return view(next);
    });
  }
}
