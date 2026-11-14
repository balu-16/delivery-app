import { get, buildQuery } from './http'
import { istDateWindow } from './mapping'
import { paiseToRupees } from './money'
import type { DashboardData, RangeKey } from '@/types'

// ── Dashboard (GET /v1/admin/dashboard — pinned new endpoint) ────────────────
// The backend buckets by IST business day and requires date-only `YYYY-MM-DD`.

export function getDashboard(range: RangeKey, storeId?: string | 'all'): Promise<DashboardData> {
  const { from, to } = istDateWindow(range)
  const qs = buildQuery({ from, to, storeId: storeId === 'all' ? undefined : storeId })
  return get<DashboardData>(`/v1/admin/dashboard${qs}`)
}

/** Derived dashboard numbers the UI renders (never fabricated — nulls honoured). */
export function dashboardMetrics(d: DashboardData) {
  const orders = d.orders
  const inProgress = (orders?.confirmed ?? 0) + (orders?.picking ?? 0) + (orders?.packed ?? 0)
  const cancelled = (orders?.cancelled ?? 0) + (orders?.expired ?? 0)
  const sales = paiseToRupees(d.invoicedSalesPaise)
  const creditNotes = paiseToRupees(d.creditNotesPaise)
  return {
    period: d.period,
    ordersPlaced: orders?.placed ?? null,
    ordersInProgress: orders ? inProgress : null,
    ordersOutForDelivery: orders?.outForDelivery ?? null,
    ordersDelivered: orders?.delivered ?? null,
    ordersCancelled: orders ? cancelled : null,
    ordersOnHold: orders?.onHold ?? null,
    storesOnline: d.stores?.online ?? null,
    storesTotal: d.stores?.total ?? null,
    customersTotal: d.customers?.total ?? null,
    customersActive: d.customers?.active ?? null,
    /** Net invoiced sales (credit notes displayed separately). */
    sales,
    creditNotes,
    refundsProcessed: paiseToRupees(d.refundsProcessedPaise),
    /** Wallet top-ups are a global metric — null when store-filtered. */
    walletTopUps: d.walletTopUpsPaise ? paiseToRupees(d.walletTopUpsPaise.total) : null,
  }
}
