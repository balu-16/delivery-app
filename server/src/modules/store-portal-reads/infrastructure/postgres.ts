import { sql } from 'kysely';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type {
  EligibleReturnOrder,
  InspectionDecision,
  InspectionDraft,
  InspectionDraftItem,
  Page,
  RecordedReturn,
  ReturnOrderDetail,
  StoreCustomerSearchItem,
  StoreOrderSearchItem,
  StorePortalReads,
  StoreProductSearchItem,
  StoreSearchItem,
  StoreSearchType,
} from '../contracts/store-portal-reads.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS: InspectionDecision[] = ['SALEABLE', 'DAMAGED', 'EXPIRED'];
const MAX_SEARCH = 100;

function boundedLimit(limit: number | undefined, fallback = 20): number {
  const value = limit ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('INVALID_INPUT');
  return value;
}

interface Cursor {
  key: string;
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const key = (parsed as Cursor).key;
    return typeof key === 'string' && key.length > 0 ? { key } : null;
  } catch {
    return null;
  }
}

function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ key })).toString('base64url');
}

function cursorFilter(cursor: Cursor | null, column: string) {
  return cursor ? sql`(${sql.raw(column)}) < ${cursor.key}` : sql`true`;
}

/**
 * Cross-aggregate store portal reads. Store scoping is enforced on every call
 * through IdentityAccess.hasStoreRole; results can only ever reference rows
 * that belong to the asserted store.
 */
export class PostgresStorePortalReads implements StorePortalReads {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}

  private async assertStoreManager(
    tx: TransactionContext | undefined,
    actorId: string,
    storeId: string,
  ): Promise<void> {
    if (
      !UUID.test(storeId) ||
      !(await this.identity.hasStoreRole(actorId, storeId, ['STORE_MANAGER'], tx))
    )
      throw new Error('STORE_NOT_FOUND');
  }

  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }

  async search(
    actorId: string,
    storeId: string,
    type: StoreSearchType,
    query: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<StoreSearchItem>> {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > MAX_SEARCH) throw new Error('INVALID_INPUT');
    const page = boundedLimit(limit);
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('INVALID_CURSOR');
    return this.run(undefined, async (tx) => {
      await this.assertStoreManager(tx, actorId, storeId);
      const pattern = `%${trimmed.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
      if (type === 'ORDERS') {
        const rows = await sql<StoreOrderSearchItem & { key: string }>`SELECT o.id AS "orderId",
            o.order_number AS "orderNumber", o.status, COALESCE(u.name,'') AS "customerName",
            o.total_paise::text AS "totalPaise", o.placed_at AS "placedAt",
            (SELECT count(*) FROM order_items oi WHERE oi.order_id=o.id)::int AS "itemCount",
            (o.placed_at::text || '|' || o.id::text) AS key
          FROM orders o JOIN users u ON u.id=o.user_id
          WHERE o.store_id=${storeId}::uuid
            AND (${cursorFilter(decoded, "(o.placed_at::text || '|' || o.id::text)")})
            AND (o.order_number ILIKE ${pattern} OR u.name ILIKE ${pattern})
          ORDER BY o.placed_at DESC, o.id DESC LIMIT ${page + 1}`.execute(tx);
        return this.page(rows.rows, page, (row) => ({
          orderId: row.orderId,
          orderNumber: row.orderNumber,
          status: row.status,
          customerName: row.customerName,
          totalPaise: row.totalPaise,
          placedAt: new Date(row.placedAt).toISOString(),
          itemCount: row.itemCount,
        }));
      }
      if (type === 'CUSTOMERS') {
        const rows = await sql<StoreCustomerSearchItem & { key: string }>`SELECT u.id AS "userId",
            u.name, u.normalized_email AS email, count(o.id)::int AS "orderCount",
            max(o.placed_at)::text AS "lastOrderAt",
            (max(o.placed_at)::text || '|' || u.id::text) AS key
          FROM users u JOIN orders o ON o.user_id=u.id
          WHERE o.store_id=${storeId}::uuid AND u.name ILIKE ${pattern}
          GROUP BY u.id,u.name,u.normalized_email
          ORDER BY max(o.placed_at) DESC, u.id DESC LIMIT ${page + 1}`.execute(tx);
        return this.page(rows.rows, page, (row) => ({
          userId: row.userId,
          name: row.name,
          email: row.email,
          orderCount: row.orderCount,
          lastOrderAt: row.lastOrderAt ? new Date(row.lastOrderAt).toISOString() : null,
        }));
      }
      const rows = await sql<StoreProductSearchItem & { key: string }>`SELECT v.id AS "variantId",
            p.name AS "productName", v.name AS "variantName", v.sku,
            (SELECT (si.on_hand - si.reserved)::text FROM store_inventory si
              WHERE si.store_id=${storeId}::uuid AND si.variant_id=v.id) AS available,
            v.sku AS key
          FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id
          WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL
            AND (p.name ILIKE ${pattern} OR v.name ILIKE ${pattern} OR v.sku ILIKE ${pattern})
          ORDER BY v.sku LIMIT ${page + 1}`.execute(tx);
      return this.page(rows.rows, page, (row) => ({
        variantId: row.variantId,
        productName: row.productName,
        variantName: row.variantName,
        sku: row.sku,
        available: row.available,
      }));
    });
  }

  async eligibleReturnOrders(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<EligibleReturnOrder>> {
    const page = boundedLimit(limit);
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('INVALID_CURSOR');
    return this.run(undefined, async (tx) => {
      await this.assertStoreManager(tx, actorId, storeId);
      const rows = await sql<EligibleReturnOrder & { key: string }>`SELECT o.id AS "orderId",
          o.order_number AS "orderNumber", COALESCE(u.name,'') AS "customerName",
          dt.failure_reason AS "failureReason", dt.updated_at AS "failedAt",
          (SELECT count(*) FROM order_items oi WHERE oi.order_id=o.id AND oi.fulfilled_qty>0)::int AS "itemCount",
          o.total_paise::text AS "totalPaise", (o.placed_at::text || '|' || o.id::text) AS key
        FROM orders o
        JOIN users u ON u.id=o.user_id
        JOIN LATERAL (
          SELECT failure_reason,updated_at FROM delivery_tasks
          WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1
        ) dt ON true
        WHERE o.store_id=${storeId}::uuid AND o.status='DELIVERY_FAILED'
          AND NOT EXISTS (SELECT 1 FROM inventory_returns r WHERE r.order_id=o.id)
          AND (${cursorFilter(decoded, "(o.placed_at::text || '|' || o.id::text)")})
        ORDER BY o.placed_at DESC, o.id DESC LIMIT ${page + 1}`.execute(tx);
      return this.page(rows.rows, page, (row) => ({
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        customerName: row.customerName,
        failureReason: row.failureReason,
        failedAt: row.failedAt ? new Date(row.failedAt).toISOString() : null,
        itemCount: row.itemCount,
        totalPaise: row.totalPaise,
      }));
    });
  }

  async recordedReturns(
    actorId: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<RecordedReturn>> {
    const page = boundedLimit(limit);
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('INVALID_CURSOR');
    return this.run(undefined, async (tx) => {
      await this.assertStoreManager(tx, actorId, storeId);
      const pattern = `%${search.trim().replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
      const rows = await sql<{
        returnId: string;
        orderId: string;
        orderNumber: string;
        customerName: string;
        failureReason: string | null;
        variantId: string;
        variantName: string;
        quantity: string;
        status: string;
        reason: string | null;
        created_at: Date;
        inspected_at: Date | null;
        key: string;
      }>`SELECT r.id AS "returnId",
          r.order_id AS "orderId", o.order_number AS "orderNumber", COALESCE(u.name,'') AS "customerName",
          dt.failure_reason AS "failureReason",
          r.variant_id AS "variantId",
          v.name AS "variantName", r.quantity::text AS quantity, r.status, r.reason,
          r.created_at, r.inspected_at, (r.created_at::text || '|' || r.id::text) AS key
        FROM inventory_returns r
        JOIN orders o ON o.id=r.order_id
        JOIN users u ON u.id=o.user_id
        LEFT JOIN LATERAL (
          SELECT failure_reason FROM delivery_tasks WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1
        ) dt ON true
        JOIN catalog_variants v ON v.id=r.variant_id
        WHERE r.store_id=${storeId}::uuid
          AND (${cursorFilter(decoded, "(r.created_at::text || '|' || r.id::text)")})
          AND (${search.trim() ? sql`(o.order_number ILIKE ${pattern} OR v.name ILIKE ${pattern})` : sql`true`})
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${page + 1}`.execute(tx);
      return this.page(rows.rows, page, (row) => ({
        returnId: row.returnId,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        customerName: row.customerName,
        failureReason: row.failureReason,
        variantId: row.variantId,
        variantName: row.variantName,
        quantity: row.quantity,
        status: row.status as RecordedReturn['status'],
        reason: row.reason,
        createdAt: new Date(row.created_at).toISOString(),
        inspectedAt: row.inspected_at ? new Date(row.inspected_at).toISOString() : null,
      }));
    });
  }

  async returnDetail(
    actorId: string,
    storeId: string,
    orderId: string,
  ): Promise<ReturnOrderDetail> {
    if (!UUID.test(orderId)) throw new Error('RESOURCE_NOT_FOUND');
    return this.run(undefined, async (tx) => {
      await this.assertStoreManager(tx, actorId, storeId);
      const orders = await sql<{
        id: string;
        order_number: string;
        status: string;
        customer_name: string;
        total_paise: string;
        failure_reason: string | null;
        failed_at: Date | null;
      }>`SELECT o.id,o.order_number,o.status,COALESCE(u.name,'') AS customer_name,
          o.total_paise::text AS total_paise, dt.failure_reason, dt.updated_at AS failed_at
        FROM orders o JOIN users u ON u.id=o.user_id
        JOIN LATERAL (
          SELECT failure_reason,updated_at FROM delivery_tasks
          WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1
        ) dt ON true
        WHERE o.id=${orderId}::uuid AND o.store_id=${storeId}::uuid`.execute(tx);
      const order = orders.rows[0];
      if (!order) throw new Error('RESOURCE_NOT_FOUND');
      const items = await sql<{
        variant_id: string;
        variant_name: string;
        quantity: string;
        expires_at: Date | null;
      }>`SELECT COALESCE(oi.fulfillment_snapshot->>'variantId',oi.variant_id::text) AS variant_id,
          COALESCE(cv.name, p.name, '') AS variant_name, sum(oi.fulfilled_qty)::text AS quantity,
          (SELECT min(b.expires_at) FROM inventory_ledger l JOIN inventory_batches b ON b.id=l.batch_id
            WHERE l.store_id=o.store_id AND l.variant_id=COALESCE(oi.fulfillment_snapshot->>'variantId',oi.variant_id::text)::uuid
              AND l.kind='RESERVE_COMMIT_PICK'
              AND (l.reference='pick:'||oi.order_id::text OR l.reference LIKE 'pick:'||oi.order_id::text||':g%')) AS expires_at
        FROM order_items oi
        JOIN orders o ON o.id=oi.order_id
        JOIN catalog_variants v ON v.id=oi.variant_id
        JOIN catalog_products p ON p.id=v.product_id
        LEFT JOIN catalog_variants cv ON cv.id=(oi.fulfillment_snapshot->>'variantId')::uuid
        WHERE oi.order_id=${orderId}::uuid AND oi.fulfilled_qty>0
        GROUP BY 1,2,oi.order_id,o.store_id,oi.fulfillment_snapshot,oi.variant_id ORDER BY 1`.execute(
        tx,
      );
      const returns = await sql<{
        id: string;
        variant_id: string;
        variant_name: string;
        quantity: string;
        status: string;
        reason: string | null;
        created_at: Date;
        inspected_at: Date | null;
      }>`SELECT r.id,r.variant_id,v.name AS variant_name,r.quantity::text AS quantity,r.status,
          r.reason,r.created_at,r.inspected_at
        FROM inventory_returns r JOIN catalog_variants v ON v.id=r.variant_id
        WHERE r.order_id=${orderId}::uuid AND r.store_id=${storeId}::uuid
        ORDER BY r.created_at DESC, r.id`.execute(tx);
      return {
        orderId: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name,
        status: order.status,
        failureReason: order.failure_reason,
        failedAt: order.failed_at ? new Date(order.failed_at).toISOString() : null,
        totalPaise: order.total_paise,
        items: items.rows.map((row) => ({
          variantId: row.variant_id,
          variantName: row.variant_name,
          quantity: row.quantity,
          expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        })),
        returns: returns.rows.map((row) => ({
          returnId: row.id,
          variantId: row.variant_id,
          variantName: row.variant_name,
          quantity: row.quantity,
          status: row.status as ReturnOrderDetail['returns'][number]['status'],
          reason: row.reason,
          createdAt: new Date(row.created_at).toISOString(),
          inspectedAt: row.inspected_at ? new Date(row.inspected_at).toISOString() : null,
        })),
      };
    });
  }

  async saveInspectionDraft(
    actorId: string,
    storeId: string,
    orderId: string,
    items: InspectionDraftItem[],
    note: string | null,
  ): Promise<InspectionDraft> {
    if (!UUID.test(orderId)) throw new Error('RESOURCE_NOT_FOUND');
    if (!items.length || items.length > 100) throw new Error('INVALID_INPUT');
    if (note !== null && note.length > 500) throw new Error('INVALID_INPUT');
    for (const item of items) {
      if (!UUID.test(item.variantId) || !/^[1-9]\d*$/.test(item.quantity))
        throw new Error('INVALID_INPUT');
      if (!DECISIONS.includes(item.decision)) throw new Error('INVALID_INPUT');
      if (item.note !== null && item.note !== undefined && item.note.length > 200)
        throw new Error('INVALID_INPUT');
    }
    return this.run(undefined, async (tx) => {
      await this.assertStoreManager(tx, actorId, storeId);
      // The order must be a failed delivery of this store, and every drafted
      // variant must be one of its fulfilled items.
      const order = await sql<{ id: string }>`SELECT id FROM orders
        WHERE id=${orderId}::uuid AND store_id=${storeId}::uuid AND status IN ('DELIVERY_FAILED','RETURNED_TO_STORE')`.execute(
        tx,
      );
      if (!order.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      const variants = new Set(
        (
          await sql<{
            variant_id: string;
          }>`SELECT COALESCE(fulfillment_snapshot->>'variantId',variant_id::text) AS variant_id
          FROM order_items WHERE order_id=${orderId}::uuid AND fulfilled_qty>0`.execute(tx)
        ).rows.map((row) => row.variant_id),
      );
      if (items.some((item) => !variants.has(item.variantId))) throw new Error('INVALID_INPUT');
      const payload = JSON.stringify({
        items: items.map((item) => ({ ...item, note: item.note ?? null })),
        note,
      });
      const saved = await sql<{
        version: number;
        updated_at: Date;
        items: unknown;
        note: string | null;
      }>`INSERT INTO return_inspection_drafts
        (order_id,store_id,saved_by,items,note,version)
        VALUES (${orderId}::uuid,${storeId}::uuid,${actorId}::uuid,${payload}::jsonb,${note},1)
        ON CONFLICT (order_id) DO UPDATE SET saved_by=${actorId}::uuid,items=${payload}::jsonb,
          note=${note},version=return_inspection_drafts.version+1,updated_at=clock_timestamp()
        RETURNING version,updated_at,items,note`.execute(tx);
      const row = saved.rows[0]!;
      return {
        orderId,
        items: (row.items as InspectionDraftItem[]) ?? [],
        note: row.note,
        version: row.version,
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  async getInspectionDraft(
    actorId: string,
    storeId: string,
    orderId: string,
  ): Promise<InspectionDraft | null> {
    if (!UUID.test(orderId)) throw new Error('RESOURCE_NOT_FOUND');
    return this.run(undefined, async (tx) => {
      await this.assertStoreManager(tx, actorId, storeId);
      const rows = await sql<{
        order_id: string;
        items: InspectionDraftItem[];
        note: string | null;
        version: number;
        updated_at: Date;
      }>`SELECT order_id,items,note,version,updated_at FROM return_inspection_drafts
        WHERE order_id=${orderId}::uuid AND store_id=${storeId}::uuid`.execute(tx);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        orderId: row.order_id,
        items: row.items ?? [],
        note: row.note,
        version: row.version,
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  private page<T, R extends { key: string }>(
    rows: R[],
    limit: number,
    map: (row: R) => T,
  ): Page<T> {
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(map),
      nextCursor:
        rows.length > limit && pageRows.length
          ? encodeCursor(pageRows[pageRows.length - 1]!.key)
          : null,
    };
  }
}
