import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type {
  StoreCodDepositItem,
  StoreCodDepositPage,
  StoreCodRiderItem,
  StoreCodRiderPage,
  StoreCodReads,
} from '../contracts/store-cod.js';

function boundedLimit(limit: number | undefined, fallback = 50): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
  return limit;
}

/** Store-role gate for every COD read (pattern copied from pick-primitives). */
async function assertStoreRole(
  identity: {
    hasStoreRole(
      userId: string,
      storeId: string,
      roles: readonly string[],
      tx?: TransactionContext,
    ): Promise<boolean>;
  },
  userId: string,
  storeId: string,
  roles: readonly 'STORE_MANAGER'[],
  tx?: TransactionContext,
): Promise<void> {
  if (!(await identity.hasStoreRole(userId, storeId, roles, tx)))
    throw new Error('RESOURCE_NOT_FOUND');
}

const scopeHash = (scope: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(scope)).digest('base64url');

function pageCursor(parts: readonly string[], scope: readonly unknown[]): string {
  return Buffer.from(JSON.stringify([...parts, scopeHash(scope)])).toString('base64url');
}

/** Scoped keyset cursor; a cursor is only valid for its store and filter. */
function pageCursorParts(
  cursor: string | undefined,
  scope: readonly unknown[],
  shapes: readonly ('instant' | 'uuid')[],
): string[] | null {
  if (cursor === undefined) return null;
  let value: unknown;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('INVALID_PAGE');
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error('INVALID_PAGE', { cause: error });
  }
  if (
    !Array.isArray(value) ||
    value.length !== shapes.length + 1 ||
    value.some((part) => typeof part !== 'string') ||
    value[shapes.length] !== scopeHash(scope)
  )
    throw new Error('INVALID_PAGE');
  const parts = value.slice(0, shapes.length) as string[];
  shapes.forEach((shape, index) => {
    const part = parts[index]!;
    if (
      shape === 'uuid' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)
    )
      throw new Error('INVALID_PAGE');
    if (shape === 'instant' && Number.isNaN(Date.parse(part))) throw new Error('INVALID_PAGE');
  });
  return parts;
}

interface RiderRow {
  userId: string;
  name: string;
  cashInHandPaise: string | null;
}

interface DepositRow {
  id: string;
  riderId: string;
  riderName: string;
  amountPaise: string;
  discrepancyPaise: string;
  depositReference: string;
  status: string;
  createdAt: Date;
}

interface DepositTotalsRow {
  depositedPaise: string;
  discrepancyPaise: string;
  count: string;
}

/**
 * Store-manager COD views: the deposit candidate list and settlement history.
 * Authorization follows the cash controller (STORE_MANAGER on the store);
 * riders surface only through store-linked delivery or settlement rows.
 */
export class PostgresStoreCodReads implements StoreCodReads {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly config: AppConfig,
  ) {}

  async eligibleRiders(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<StoreCodRiderPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const size = boundedLimit(limit);
    const scope = ['store-cod-riders', storeId];
    const [after] = pageCursorParts(cursor, scope, ['uuid']) ?? [null];
    let limitPaise: string | null;
    try {
      limitPaise = await this.config.get('cashInHandLimitPaise');
    } catch {
      limitPaise = null;
    }
    const rows = await sql<RiderRow>`WITH linked AS (
        SELECT dt.rider_id AS user_id FROM delivery_tasks dt
        WHERE dt.store_id=${storeId}::uuid AND dt.rider_id IS NOT NULL
        UNION
        SELECT cs.rider_id FROM cod_settlements cs WHERE cs.store_id=${storeId}::uuid
      )
      SELECT linked.user_id AS "userId",u.name AS name,
        (SELECT balance_after::text FROM rider_cash_ledger
          WHERE rider_id=linked.user_id ORDER BY created_at DESC,id DESC LIMIT 1) AS "cashInHandPaise"
      FROM linked
      JOIN users u ON u.id=linked.user_id
      WHERE (${after}::uuid IS NULL OR linked.user_id>${after}::uuid)
      ORDER BY linked.user_id LIMIT ${size + 1}`.execute(this.db);
    const pageRows = rows.rows.slice(0, size);
    const items: StoreCodRiderItem[] = pageRows.map((row) => ({
      userId: row.userId,
      name: row.name,
      cashInHandPaise: row.cashInHandPaise ?? '0',
      limitPaise,
      hasOutstanding: row.cashInHandPaise !== null && row.cashInHandPaise !== '0',
    }));
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: rows.rows.length > size && last ? pageCursor([last.userId], scope) : null,
    };
  }

  async deposits(
    actorId: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
  ): Promise<StoreCodDepositPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const size = boundedLimit(limit);
    if (search.length > 100) throw new Error('INVALID_INPUT');
    const scope = ['store-cod-deposits', storeId, search];
    const after = pageCursorParts(cursor, scope, ['instant', 'uuid']);
    const [instant, id] = after ?? [null, null];
    const rows = await sql<DepositRow>`SELECT cs.id,cs.rider_id AS "riderId",u.name AS "riderName",
      cs.amount_paise::text AS "amountPaise",cs.discrepancy_paise::text AS "discrepancyPaise",
      cs.deposit_reference AS "depositReference",cs.state AS status,cs.created_at AS "createdAt"
      FROM cod_settlements cs
      JOIN users u ON u.id=cs.rider_id
      WHERE cs.store_id=${storeId}::uuid
        AND (${search}='' OR u.name ILIKE '%'||${search}||'%' OR cs.deposit_reference ILIKE '%'||${search}||'%')
        AND (${instant}::timestamptz IS NULL OR (cs.created_at,cs.id) < (${instant}::timestamptz,${id}::uuid))
      ORDER BY cs.created_at DESC,cs.id DESC LIMIT ${size + 1}`.execute(this.db);
    // Totals deliberately re-run the page predicate (minus the cursor) so they
    // cover the whole matching set, not only the returned page.
    const totals = await sql<DepositTotalsRow>`SELECT
      COALESCE(SUM(cs.amount_paise),0)::text AS "depositedPaise",
      COALESCE(SUM(cs.discrepancy_paise),0)::text AS "discrepancyPaise",
      count(*)::text AS count
      FROM cod_settlements cs
      LEFT JOIN users u ON u.id=cs.rider_id
      WHERE cs.store_id=${storeId}::uuid
        AND (${search}='' OR u.name ILIKE '%'||${search}||'%' OR cs.deposit_reference ILIKE '%'||${search}||'%')`.execute(
      this.db,
    );
    const pageRows = rows.rows.slice(0, size);
    const items: StoreCodDepositItem[] = pageRows.map((row) => ({
      id: row.id,
      riderId: row.riderId,
      riderName: row.riderName,
      amountPaise: row.amountPaise,
      discrepancyPaise: row.discrepancyPaise,
      depositReference: row.depositReference,
      status: row.status === 'CLEARED' ? 'CLEARED' : 'PENDING',
      createdAt: row.createdAt,
    }));
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        rows.rows.length > size && last
          ? pageCursor([last.createdAt.toISOString(), last.id], scope)
          : null,
      totals: {
        depositedPaise: totals.rows[0]?.depositedPaise ?? '0',
        discrepancyPaise: totals.rows[0]?.discrepancyPaise ?? '0',
        count: Number(totals.rows[0]?.count ?? '0'),
      },
    };
  }
}
