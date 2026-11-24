import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type {
  InventoryAdjustmentItem,
  InventoryAdjustmentPage,
  InventoryBatchItem,
  InventoryBatchPage,
  InventoryCountEntry,
  InventoryCountItem,
  InventoryCountPage,
  InventoryExportItem,
  InventoryExportResult,
  InventoryPortalReads,
  InventoryReceiptItem,
  InventoryReceiptPage,
} from '../contracts/portal-reads.js';
import { stockCursor, stockCursorId } from './paging.js';

/** Hard cap for the CSV export; anything beyond it is reported via `truncated`. */
const EXPORT_MAX_ROWS = 2000;

/** Store-role gate for every portal read (pattern copied from pick-primitives). */
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

/** Scoped keyset cursor over a tuple of string parts; ties a page to its filters. */
function tupleCursor(parts: readonly string[], scope: readonly unknown[]): string {
  return Buffer.from(JSON.stringify([...parts, scopeHash(scope)])).toString('base64url');
}

function tupleCursorParts(
  cursor: string | undefined,
  scope: readonly unknown[],
  shapes: readonly ('instant' | 'uuid' | 'text')[],
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

interface AdjustmentPageRow {
  reference: string;
  counted: string;
  actorId: string;
  actorName: string | null;
  createdAt: Date;
  approvalId: string | null;
  approvalStatus: string | null;
  payloadVariantId: string | null;
  payloadBatchId: string | null;
  payloadReason: string | null;
  ledgerRef: string;
}

interface AdjustmentLedgerRow {
  reference: string;
  variantId: string | null;
  batchId: string | null;
  delta: string | null;
  auditReason: string | null;
}

interface CountPageRow {
  reference: string;
  actorId: string;
  actorName: string | null;
  approvalRequired: boolean;
  createdAt: Date;
  approvalStatus: string | null;
  executedAt: Date | null;
  payloadVariantId: string | null;
  payloadBatchId: string | null;
  payloadCounted: string | null;
  payloadReason: string | null;
  ledgerRef: string;
}

interface CountLedgerRow {
  reference: string;
  variantId: string | null;
  batchId: string | null;
  appliedAt: Date | null;
  auditReason: string | null;
  auditCounted: string | null;
}

/**
 * The adjust flow derives its count/claim reference as `adjust-${fingerprint(reference)}`
 * where fingerprint() is sha256 over JSON.stringify(reference) — i.e. the quoted string.
 * References are idempotency keys without JSON-escaped characters, so the hex digest is
 * reproducible in SQL; a mismatch only yields null lateral rows, never a wrong row.
 */
const claimRefOf = (column: string) =>
  `'adjust-'||encode(sha256(convert_to('"'||${column}||'"','UTF8')),'hex')`;

function countState(approvalStatus: string | null): InventoryCountEntry['state'] {
  if (approvalStatus === null || approvalStatus === 'EXECUTED') return 'APPLIED';
  if (approvalStatus === 'PENDING' || approvalStatus === 'EXPIRED' || approvalStatus === 'REJECTED')
    return approvalStatus;
  return 'PENDING';
}

function adjustmentState(approvalStatus: string | null): InventoryAdjustmentItem['state'] {
  if (approvalStatus === null) return 'APPLIED';
  if (approvalStatus === 'EXECUTED') return 'APPROVED';
  if (approvalStatus === 'PENDING' || approvalStatus === 'EXPIRED' || approvalStatus === 'REJECTED')
    return approvalStatus;
  return 'PENDING';
}

/** Store-portal history reads over the inventory ledger, batches and count claims. */
export class PostgresInventoryPortalReads implements InventoryPortalReads {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly config?: AppConfig,
  ) {}
  private size(limit?: number): number {
    const value = limit ?? 50;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('INVALID_INPUT');
    return value;
  }

  async receipts(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryReceiptPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const size = this.size(limit);
    const scope = ['store-receipts', storeId];
    const after = tupleCursorParts(cursor, scope, ['instant', 'uuid']);
    const [instant, id] = after ?? [null, null];
    const rows =
      await sql<InventoryReceiptItem>`SELECT l.id,l.reference,l.variant_id AS "variantId",p.name AS "variantName",v.sku,
      l.batch_id AS "batchId",b.batch_code AS "batchCode",b.expires_at AS "expiresAt",
      l.on_hand_delta::text AS quantity,l.actor_id AS "actorId",u.name AS "actorName",l.created_at AS "createdAt"
      FROM inventory_ledger l
      JOIN inventory_batches b ON b.id=l.batch_id
      JOIN catalog_variants v ON v.id=l.variant_id
      JOIN catalog_products p ON p.id=v.product_id
      LEFT JOIN users u ON u.id=l.actor_id
      WHERE l.store_id=${storeId}::uuid AND l.kind='RECEIPT'
        AND (${instant}::timestamptz IS NULL OR (l.created_at,l.id) < (${instant}::timestamptz,${id}::uuid))
      ORDER BY l.created_at DESC,l.id DESC LIMIT ${size + 1}`.execute(this.db);
    const items = rows.rows.slice(0, size);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.rows.length > size && last
          ? tupleCursor([last.createdAt.toISOString(), last.id], scope)
          : null,
    };
  }

  async adjustments(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryAdjustmentPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const size = this.size(limit);
    const scope = ['store-adjustments', storeId];
    const after = tupleCursorParts(cursor, scope, ['instant', 'uuid', 'text']);
    const [instant, afterActor, afterReference] = after ?? [null, null, null];
    // Approval status joins through the maker/checker request the adjust flow
    // creates for the derived claim reference (unique payload index makes the
    // join 1:1); the applied ledger movement and its audit row supply the
    // variant/batch/delta for executed adjustments.
    const page = await sql<AdjustmentPageRow>`SELECT ma.reference,ma.counted::text AS counted,
      ma.actor_id AS "actorId",u.name AS "actorName",ma.created_at AS "createdAt",
      mcr.id AS "approvalId",mcr.status AS "approvalStatus",
      mcr.payload->>'variantId' AS "payloadVariantId",mcr.payload->>'batchId' AS "payloadBatchId",
      mcr.payload->>'reason' AS "payloadReason",
      'count:'||ma.store_id::text||':'||ma.actor_id::text||':adjust-'||encode(sha256(convert_to('"'||ma.reference||'"','UTF8')),'hex') AS "ledgerRef"
      FROM inventory_manual_adjustments ma
      LEFT JOIN users u ON u.id=ma.actor_id
      LEFT JOIN maker_checker_requests mcr ON mcr.action='INVENTORY_COUNT'
        AND mcr.payload->>'maker'=ma.actor_id::text
        AND mcr.payload->>'storeId'=ma.store_id::text
        AND mcr.payload->>'reference'=${claimRefOf('ma.reference')}
      WHERE ma.store_id=${storeId}::uuid
        AND (${instant}::timestamptz IS NULL OR (ma.created_at,ma.actor_id,ma.reference) < (${instant}::timestamptz,${afterActor}::uuid,${afterReference}))
      ORDER BY ma.created_at DESC,ma.actor_id DESC,ma.reference DESC
      LIMIT ${size + 1}`.execute(this.db);
    const pageRows = page.rows.slice(0, size);
    const refs = pageRows.map((row) => row.ledgerRef);
    const ledger = refs.length
      ? (
          await sql<AdjustmentLedgerRow>`SELECT l.reference,l.variant_id::text AS "variantId",l.batch_id::text AS "batchId",
          l.on_hand_delta::text AS delta,
          (SELECT a.details->>'reason' FROM audit_log a WHERE a.subject_type='inventory_batch'
            AND a.subject_id=l.batch_id::text AND a.action='INVENTORY_COUNT' AND a.details->>'reference'=l.reference
            ORDER BY a.created_at DESC LIMIT 1) AS "auditReason"
          FROM inventory_ledger l
          WHERE l.store_id=${storeId}::uuid AND l.kind='ADJUSTMENT' AND l.reference=ANY(${refs}::text[])`.execute(
            this.db,
          )
        ).rows
      : [];
    const byRef = new Map(ledger.map((row) => [row.reference, row]));
    const items = await this.decorateAdjustments(pageRows, byRef);
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        page.rows.length > size && last
          ? tupleCursor([last.createdAt.toISOString(), last.actorId, last.reference], scope)
          : null,
    };
  }

  private async decorateAdjustments(
    pageRows: AdjustmentPageRow[],
    byRef: Map<string, AdjustmentLedgerRow>,
  ): Promise<InventoryAdjustmentItem[]> {
    const variantIds = [
      ...new Set(
        pageRows.flatMap((row) => {
          const led = byRef.get(row.ledgerRef);
          const variantId = led?.variantId ?? row.payloadVariantId;
          return variantId ? [variantId] : [];
        }),
      ),
    ];
    const batchIds = [
      ...new Set(
        pageRows.flatMap((row) => {
          const led = byRef.get(row.ledgerRef);
          const batchId = led?.batchId ?? row.payloadBatchId;
          return batchId ? [batchId] : [];
        }),
      ),
    ];
    const variants = variantIds.length
      ? (
          await sql<{ id: string; sku: string; name: string }>`SELECT v.id::text AS id,v.sku,p.name
          FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id
          WHERE v.id=ANY(${variantIds}::uuid[])`.execute(this.db)
        ).rows
      : [];
    const batches = batchIds.length
      ? (
          await sql<{
            id: string;
            batchCode: string;
          }>`SELECT id::text AS id,batch_code AS "batchCode"
          FROM inventory_batches WHERE id=ANY(${batchIds}::uuid[])`.execute(this.db)
        ).rows
      : [];
    const variantById = new Map(variants.map((row) => [row.id, row]));
    const batchById = new Map(batches.map((row) => [row.id, row.batchCode]));
    return pageRows.map((row) => {
      const led = byRef.get(row.ledgerRef);
      const variantId = led?.variantId ?? row.payloadVariantId;
      const batchId = led?.batchId ?? row.payloadBatchId;
      const variant = variantId ? variantById.get(variantId) : undefined;
      return {
        reference: row.reference,
        counted: row.counted,
        delta: led?.delta ?? null,
        variantId,
        variantName: variant?.name ?? null,
        batchId,
        batchCode: batchId ? (batchById.get(batchId) ?? null) : null,
        reason: row.payloadReason ?? led?.auditReason ?? null,
        actorId: row.actorId,
        actorName: row.actorName,
        state: adjustmentState(row.approvalStatus),
        approvalId: row.approvalId,
        createdAt: row.createdAt,
      };
    });
  }

  async counts(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryCountPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const size = this.size(limit);
    const scope = ['store-counts', storeId];
    const after = tupleCursorParts(cursor, scope, ['instant', 'uuid', 'text']);
    const [instant, afterActor, afterReference] = after ?? [null, null, null];
    // Cycle-count claims only; manual-adjustment claims (derived `adjust-<sha256>`
    // references) are listed by the adjustments read. State: a claim without a
    // maker/checker request was applied immediately, otherwise the approval
    // status decides.
    const page =
      await sql<CountPageRow>`SELECT cc.reference,cc.actor_id AS "actorId",u.name AS "actorName",
      cc.approval_required AS "approvalRequired",cc.created_at AS "createdAt",
      mcr.status AS "approvalStatus",mcr.executed_at AS "executedAt",
      mcr.payload->>'variantId' AS "payloadVariantId",mcr.payload->>'batchId' AS "payloadBatchId",
      mcr.payload->>'counted' AS "payloadCounted",mcr.payload->>'reason' AS "payloadReason",
      'count:'||cc.store_id::text||':'||cc.actor_id::text||':'||cc.reference AS "ledgerRef"
      FROM inventory_count_claims cc
      LEFT JOIN users u ON u.id=cc.actor_id
      LEFT JOIN maker_checker_requests mcr ON mcr.action='INVENTORY_COUNT'
        AND mcr.payload->>'maker'=cc.actor_id::text
        AND mcr.payload->>'storeId'=cc.store_id::text
        AND mcr.payload->>'reference'=cc.reference
      WHERE cc.store_id=${storeId}::uuid AND cc.reference !~ '^adjust-[0-9a-f]{64}$'
        AND (${instant}::timestamptz IS NULL OR (cc.created_at,cc.actor_id,cc.reference) < (${instant}::timestamptz,${afterActor}::uuid,${afterReference}))
      ORDER BY cc.created_at DESC,cc.actor_id DESC,cc.reference DESC
      LIMIT ${size + 1}`.execute(this.db);
    const pageRows = page.rows.slice(0, size);
    const refs = pageRows.map((row) => row.ledgerRef);
    const ledger: CountLedgerRow[] = refs.length
      ? (
          await sql<CountLedgerRow>`SELECT l.reference,l.variant_id::text AS "variantId",l.batch_id::text AS "batchId",
          l.created_at AS "appliedAt",
          (SELECT a.details->>'reason' FROM audit_log a WHERE a.subject_type='inventory_batch'
            AND a.subject_id=l.batch_id::text AND a.action='INVENTORY_COUNT' AND a.details->>'reference'=l.reference
            ORDER BY a.created_at DESC LIMIT 1) AS "auditReason",
          (SELECT a.details->>'counted' FROM audit_log a WHERE a.subject_type='inventory_batch'
            AND a.subject_id=l.batch_id::text AND a.action='INVENTORY_COUNT' AND a.details->>'reference'=l.reference
            ORDER BY a.created_at DESC LIMIT 1) AS "auditCounted"
          FROM inventory_ledger l
          WHERE l.store_id=${storeId}::uuid AND l.kind IN ('CYCLE_COUNT','ADJUSTMENT') AND l.reference=ANY(${refs}::text[])`.execute(
            this.db,
          )
        ).rows
      : [];
    const byRef = new Map(ledger.map((row) => [row.reference, row]));
    const variantIds = [
      ...new Set(
        pageRows.flatMap((row) => {
          const led = byRef.get(row.ledgerRef);
          const variantId = led?.variantId ?? row.payloadVariantId;
          return variantId ? [variantId] : [];
        }),
      ),
    ];
    const batchIds = [
      ...new Set(
        pageRows.flatMap((row) => {
          const led = byRef.get(row.ledgerRef);
          const batchId = led?.batchId ?? row.payloadBatchId;
          return batchId ? [batchId] : [];
        }),
      ),
    ];
    const variants = variantIds.length
      ? (
          await sql<{ id: string; name: string }>`SELECT v.id::text AS id,p.name
          FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id
          WHERE v.id=ANY(${variantIds}::uuid[])`.execute(this.db)
        ).rows
      : [];
    const batches = batchIds.length
      ? (
          await sql<{
            id: string;
            batchCode: string;
          }>`SELECT id::text AS id,batch_code AS "batchCode"
          FROM inventory_batches WHERE id=ANY(${batchIds}::uuid[])`.execute(this.db)
        ).rows
      : [];
    const variantById = new Map(variants.map((row) => [row.id, row.name]));
    const batchById = new Map(batches.map((row) => [row.id, row.batchCode]));
    const items: InventoryCountEntry[] = pageRows.map((row) => {
      const led = byRef.get(row.ledgerRef);
      const variantId = led?.variantId ?? row.payloadVariantId;
      const batchId = led?.batchId ?? row.payloadBatchId;
      const counted = row.payloadCounted ?? led?.auditCounted ?? null;
      const reason = row.payloadReason ?? led?.auditReason ?? null;
      const item: InventoryCountItem | null =
        variantId || batchId || counted || reason
          ? {
              variantId,
              variantName: variantId ? (variantById.get(variantId) ?? null) : null,
              batchId,
              batchCode: batchId ? (batchById.get(batchId) ?? null) : null,
              counted,
              reason,
            }
          : null;
      return {
        actorId: row.actorId,
        actorName: row.actorName,
        reference: row.reference,
        state: countState(row.approvalStatus),
        approvalRequired: row.approvalRequired,
        items: item ? [item] : [],
        createdAt: row.createdAt,
        completedAt: led?.appliedAt ?? row.executedAt,
      };
    });
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        page.rows.length > size && last
          ? tupleCursor([last.createdAt.toISOString(), last.actorId, last.reference], scope)
          : null,
    };
  }

  async batches(
    actorId: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
  ): Promise<InventoryBatchPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const size = this.size(limit);
    if (search.length > 100) throw new Error('INVALID_INPUT');
    const scope = ['store-batches', storeId, search];
    const after = stockCursorId(cursor, scope);
    const rows =
      await sql<InventoryBatchItem>`SELECT b.id AS "batchId",b.variant_id AS "variantId",v.sku,p.name,
      b.batch_code AS "batchCode",b.expires_at AS "expiresAt",b.state,
      b.on_hand::text AS "onHand",b.reserved::text,(b.on_hand-b.reserved)::text AS available,
      i.bin_location AS "binLocation",i.version::text AS version
      FROM inventory_batches b
      JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id
      JOIN catalog_variants v ON v.id=b.variant_id
      JOIN catalog_products p ON p.id=v.product_id
      WHERE b.store_id=${storeId}::uuid
        AND (${after}::uuid IS NULL OR b.id>${after}::uuid)
        AND (${search}='' OR p.name ILIKE '%'||${search}||'%' OR v.sku ILIKE '%'||${search}||'%' OR v.barcode=${search} OR b.batch_code ILIKE '%'||${search}||'%')
      ORDER BY b.id LIMIT ${size + 1}`.execute(this.db);
    const items = rows.rows.slice(0, size);
    const last = items.at(-1);
    const inventoryAdjustmentApprovalUnits = this.config
      ? await this.config.get('inventoryAdjustmentApprovalUnits')
      : 100;
    return {
      items,
      nextCursor: rows.rows.length > size && last ? stockCursor(last.batchId, scope) : null,
      inventoryAdjustmentApprovalUnits,
    };
  }

  async exportStock(
    actorId: string,
    storeId: string,
    search: string,
  ): Promise<InventoryExportResult> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    if (search.length > 100) throw new Error('INVALID_INPUT');
    // Same row shape and ordering as InventoryManagement.list, minus pagination.
    const rows =
      await sql<InventoryExportItem>`SELECT i.variant_id AS "variantId",i.bin_location AS "binLocation",v.sku,v.barcode,p.name,
      i.on_hand::text AS "onHand",i.reserved::text,a.available::text,i.version::text
      FROM store_inventory i
      JOIN catalog_variants v ON v.id=i.variant_id
      JOIN catalog_products p ON p.id=v.product_id
      JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id
      WHERE i.store_id=${storeId}::uuid
        AND (${search}='' OR p.name ILIKE '%'||${search}||'%' OR v.sku ILIKE '%'||${search}||'%' OR v.barcode=${search})
      ORDER BY i.variant_id LIMIT ${EXPORT_MAX_ROWS + 1}`.execute(this.db);
    return {
      items: rows.rows.slice(0, EXPORT_MAX_ROWS),
      truncated: rows.rows.length > EXPORT_MAX_ROWS,
    };
  }
}
