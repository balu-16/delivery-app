import { get, post, buildQuery, sendIdempotent } from './http'
import type { CursorPage, ExpiringBatch, InventorySummaryRow, LedgerRow, ShelfLifePolicy, StockRow } from '@/types'

// ── Inventory: per-store report / ledger / shelf-life / cross-store summary ──

interface BalanceRow { variantId: string; onHand: string; reserved: string; available: string; version: string }
interface StockItemRow extends BalanceRow { sku: string; barcode: string | null; name: string }
interface LedgerApiRow {
  id: string; reference: string; variantId: string; batchId: string; kind: string
  onHandDelta: string; reservedDelta: string; actorId: string | null; createdAt: string
}
interface ShelfRow { categoryId: string; minSeconds: number; version: string }

const n = (s: string | null | undefined) => (s == null ? 0 : Math.trunc(Number(s)) || 0)

export function inventoryReport(storeId: string, limit = 100, cursor?: string): Promise<CursorPage<StockRow>> {
  const qs = buildQuery({ storeId, limit, cursor })
  return get<{ items: BalanceRow[]; nextCursor: string | null }>(`/v1/admin/inventory/report${qs}`).then((res) => ({
    // Report rows carry only quantities — join names/sku from the summary endpoint.
    items: (res.items ?? []).map((r) => ({
      variantId: r.variantId, sku: null, name: null,
      onHand: n(r.onHand), reserved: n(r.reserved), available: n(r.available), version: r.version,
    })),
    nextCursor: res.nextCursor ?? null,
  }))
}

export function inventoryLedger(storeId: string, opts?: { variantId?: string; limit?: number; cursor?: string }): Promise<CursorPage<LedgerRow>> {
  const qs = buildQuery({ storeId, variantId: opts?.variantId, limit: opts?.limit, cursor: opts?.cursor })
  return get<{ items: LedgerApiRow[]; nextCursor: string | null }>(`/v1/admin/inventory/ledger${qs}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({
      id: r.id, reference: r.reference, variantId: r.variantId, batchId: r.batchId, kind: r.kind,
      onHandDelta: n(r.onHandDelta), reservedDelta: n(r.reservedDelta), actorId: r.actorId ?? null, createdAt: r.createdAt,
    })),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Cross-store summary — pinned new endpoint GET /v1/admin/inventory/summary. */
export function inventorySummary(opts?: { search?: string; limit?: number; cursor?: string }): Promise<CursorPage<InventorySummaryRow>> {
  const qs = buildQuery({ search: opts?.search, limit: opts?.limit, cursor: opts?.cursor })
  return get<{ items: InventorySummaryRow[]; nextCursor: string | null }>(`/v1/admin/inventory/summary${qs}`).then((res) => ({
    items: res.items ?? [],
    nextCursor: res.nextCursor ?? null,
  }))
}

export function shelfLifeList(limit = 50, cursor?: string): Promise<CursorPage<ShelfLifePolicy>> {
  return get<{ items: ShelfRow[]; nextCursor: string | null }>(`/v1/admin/inventory/shelf-life${buildQuery({ limit, cursor })}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({ categoryId: r.categoryId, minSeconds: r.minSeconds, version: r.version })),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Save a category shelf-life policy (Idempotency-Key header required). */
export function shelfLifeSet(idempotencyKey: string, input: { categoryId: string; minSeconds: number; expectedVersion: string; reason: string }) {
  return sendIdempotent<unknown>('POST', '/v1/admin/inventory/shelf-life', input, idempotencyKey)
}

export const approveInventoryAdjustment = (idempotencyKey: string, adjustmentId: string) =>
  sendIdempotent<unknown>('POST', `/v1/admin/inventory/adjustments/${adjustmentId}/approve`, {}, idempotencyKey)

/** Expiring batches feed the "expiring stock" panel (server-driven window). */
export function expiringBatches(storeId: string, limit = 50, cursor?: string): Promise<CursorPage<ExpiringBatch>> {
  // NOTE: batch/expiry listing rides the report surface today; when the backend
  // exposes GET /v1/admin/inventory/expiring this call moves there.
  const qs = buildQuery({ storeId, limit, cursor })
  return get<{ items: ExpiringBatch[]; nextCursor: string | null }>(`/v1/admin/inventory/expiring${qs}`).then((res) => ({
    items: res.items ?? [],
    nextCursor: res.nextCursor ?? null,
  }))
}
