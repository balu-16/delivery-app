/**
 * Store portal API layer — every function talks to the real /v1/store
 * backend through the cookie session. All IDs, statuses, quantities and
 * timestamps come from the server; nothing is synthesized client-side.
 */
import { apiGet, apiPatch, apiPost } from './http'
import {
  mapTask, mapTaskStatus, mapBatch, mapReceipt, mapCountSession, mapAdjustment,
  mapStatusChange, mapNotification, mapRiderApplication, mapDeposit, mapReturnParcel,
  mapReturnReason, deriveIcon, num,
  type BackendPickTaskView, type BackendStoreOrder, type BackendBatchRow, type BackendReceiptRow,
  type BackendStockBalanceRow, type BackendExpiringBatchRow,
  type BackendAdjustmentRow, type BackendCountSession, type BackendStoreDetails, type BackendStatusHistoryEntry,
  type BackendNotification, type BackendStaffMember, type BackendKpis, type BackendSlaTask,
  type BackendReturnRow, type BackendEligibleReturnOrder, type BackendReturnOrderDetail,
  type BackendRiderApplication, type BackendCodDeposit, type BackendCodRider,
} from './mapping'
import type {
  PickingTask, ReturnParcel, RiderApplication, CodDeposit, InventoryBatch,
  StockReceipt, StockCount, StockAdjustment, StoreStatusChange, StoreNotification,
  StoreNotificationPrefs, ReturnReason,
} from '@dairydirect/shared/types'
import type { StoreDashboardSummary } from './storeSelectors'

export interface Page<T> { items: T[]; nextCursor: string | null }

/** Aggregates cursor pages up to a sane ceiling for views that need the full set. */
async function collect<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, maxRounds = 8): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (let round = 0; round < maxRounds; round += 1) {
    const page = await fetchPage(cursor)
    out.push(...page.items)
    if (!page.nextCursor) return out
    cursor = page.nextCursor
  }
  return out
}

// ── §1 Store dashboard ─────────────────────────────────────────
export interface CodRider {
  id: string
  name: string
  cashInHand: number
  limitPaise: number | null
  hasOutstanding: boolean
}
export interface BackendDashboard {
  kpis: BackendKpis
  board: {
    waiting: number
    beingPicked: number
    readyToPack: number
    readyForHandover: number
    hourly: Array<{ label: string; completed: number; open: number }>
  }
  workload: { staff: BackendStaffMember[]; breaches: BackendSlaTask[] }
  upcomingTasks: BackendPickTaskView[]
  alerts: { unreadNotifications: number }
  store: { status: 'ONLINE' | 'PAUSED' | 'OFFLINE'; pauseReason: string | null; version: string }
}

/** IST business-day bucket for "today" comparisons (server timestamps are UTC ISO). */
export function istDayKey(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d)
}

export async function getStoreDashboardSummary(storeId: string): Promise<StoreDashboardSummary> {
  const [dash, status, lowStock, expiring, eligible, recorded, deposits, riderApps] = await Promise.all([
    apiGet<BackendDashboard>(`/v1/store/dashboard?storeId=${storeId}`),
    apiGet<{ store: BackendStoreDetails; history: BackendStatusHistoryEntry[] }>(`/v1/store/status?storeId=${storeId}`),
    apiGet<Page<{ variantId: string; variantName?: string; productName?: string; available: string; reorderLevel?: string }>>(`/v1/store/inventory/low-stock?storeId=${storeId}&limit=50`),
    apiGet<Page<{ variantId: string; variantName?: string; productName?: string; expiresAt: string; available: string }>>(`/v1/store/inventory/expiring?storeId=${storeId}&limit=50`),
    listEligibleReturnOrders(storeId),
    listRecordedReturns(storeId),
    listCodDeposits(storeId),
    listRiderApplicationsForStore(storeId, 'all'),
  ])
  const todayKey = istDayKey(new Date().toISOString())
  const now = Date.now()
  const upcoming = dash.upcomingTasks.map((view) => ({
    taskId: view.id,
    orderId: view.orderId,
    orderNumber: view.orderNumber ?? view.orderId,
    customerName: view.customerName || '—',
    itemCount: view.items.reduce((a, i) => a + num(i.expectedQty), 0),
    dueBy: view.slaDueAt,
    overdue: new Date(view.slaDueAt).getTime() < now,
    status: mapTaskStatus(view.status, view.orderStatus),
    assigneeName: view.assignedToName,
  }))
  const processedToday = recorded.filter((r) => r.processedAt && istDayKey(r.processedAt) === todayKey).length
  const codToday = deposits.filter((d) => istDayKey(d.at) === todayKey)
  return {
    storeId,
    date: todayKey,
    openPickingTasks: dash.kpis.openTasks,
    completedToday: dash.kpis.completedToday,
    deadlineBreaches: dash.kpis.slaBreachesToday,
    avgPickingTimeMin: num(dash.kpis.avgPickSeconds) / 60,
    substitutedRatePct: num(dash.kpis.shortRateBps) / 100,
    pendingRiderApps: riderApps.filter((a) => a.status === 'pending' || a.status === 'under_review').length,
    storeStatus: status.store.status === 'PAUSED' ? 'paused' : status.store.status === 'OFFLINE' ? 'offline' : 'online',
    storeName: status.store.name,
    storeCode: status.store.storeId.slice(-6),
    lowStock: lowStock.items.map((row) => ({ variantName: row.variantName ?? row.productName ?? row.variantId, qty: num(row.available), reorderLevel: num(row.reorderLevel) })),
    expiringStock: expiring.items.map((row) => ({ variantName: row.variantName ?? row.productName ?? row.variantId, qty: num(row.available), expiryDate: row.expiresAt, daysLeft: Math.max(0, Math.round((new Date(row.expiresAt).getTime() - now) / 86400000)) })),
    hourly: dash.board.hourly,
    byStatus: {
      waiting: dash.board.waiting,
      beingPicked: dash.board.beingPicked,
      readyToPack: dash.board.readyToPack,
      readyHandover: dash.board.readyForHandover,
    },
    staffWorkload: dash.workload.staff.map((s) => ({ id: s.userId, name: s.name, activeTasks: s.activeTasks, level: s.activeTasks >= 4 ? 'High' : s.activeTasks >= 2 ? 'Medium' : 'Low', status: 'active' as const })),
    avgTasksPerActivePicker: dash.workload.staff.length ? Number((dash.kpis.openTasks / dash.workload.staff.length).toFixed(1)) : 0,
    upcoming,
    overdueCount: upcoming.filter((u) => u.overdue).length,
    dueSoonCount: upcoming.filter((u) => !u.overdue && new Date(u.dueBy).getTime() - now <= 30 * 60000).length,
    lowStockCount: lowStock.items.length,
    expiringCount: expiring.items.length,
    pendingReturns: eligible.length,
    underInspection: recorded.filter((r) => r.status === 'under_inspection').length,
    processedToday,
    inQuarantine: recorded.filter((r) => r.status !== 'processed').length,
    codTodayTotal: codToday.reduce((a, d) => a + d.amount, 0),
    codTodayCount: codToday.length,
  }
}

// ── §2 Orders & picking ────────────────────────────────────────
export interface PickingTaskRow { task: PickingTask; order: { customerName: string; orderNumber: string; itemCount: number } }

function taskSortKey(t: PickingTask): string { return t.deadline }

export async function listPickingTasks(
  storeId: string,
  tab: 'queue' | 'all' | 'mine',
  _assigneeId: string | null,
  filters: { status?: string; search?: string } = {},
): Promise<PickingTaskRow[]> {
  const scope = tab === 'queue' ? 'QUEUE' : tab === 'mine' ? 'MINE' : 'ALL'
  const tasks = await collect<BackendPickTaskView>((cursor) =>
    apiGet<Page<BackendPickTaskView>>(`/v1/store/pick-tasks?storeId=${storeId}&scope=${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  let rows: PickingTaskRow[] = tasks.map((view) => ({
    task: mapTask(view),
    order: {
      customerName: view.customerName || '—',
      orderNumber: view.orderNumber ?? view.orderId,
      itemCount: view.items.reduce((a, i) => a + num(i.expectedQty), 0),
    },
  }))
  if (filters.status && filters.status !== 'all') rows = rows.filter((r) => r.task.status === filters.status)
  if (filters.search) {
    const q = filters.search.toLowerCase()
    rows = rows.filter((r) =>
      r.task.id.toLowerCase().includes(q) ||
      r.task.orderId.toLowerCase().includes(q) ||
      r.order.customerName.toLowerCase().includes(q) ||
      r.order.orderNumber.toLowerCase().includes(q))
  }
  return rows.sort((a, b) => taskSortKey(a.task).localeCompare(taskSortKey(b.task)))
}

export async function getPickingTask(id: string): Promise<PickingTask | null> {
  try {
    const view = await apiGet<BackendPickTaskView>(`/v1/store/pick-tasks/${id}`)
    return mapTask(view)
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

export async function listStoreOrders(storeId: string): Promise<BackendStoreOrder[]> {
  return collect<BackendStoreOrder>((cursor) =>
    apiGet<Page<BackendStoreOrder>>(`/v1/store/orders?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
}

// ── §3 Inventory ───────────────────────────────────────────────
export interface StockRow {
  batch: InventoryBatch
  variantName: string
  sku: string
  batchCode: string
  status: string
  /** store_inventory version — required by the manual-adjustment endpoint. */
  version: string
  onHand: number
  available: number
}
export async function listStoreStock(storeId: string, filters: { search?: string; status?: string } = {}): Promise<StockRow[]> {
  const rows = await collect<BackendBatchRow>((cursor) =>
    apiGet<Page<BackendBatchRow>>(`/v1/store/inventory/batches?storeId=${storeId}${filters.search ? `&search=${encodeURIComponent(filters.search)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=100`))
  const now = Date.now()
  let stock: StockRow[] = rows.map((b) => {
    const variantName = b.name ?? b.variantName ?? b.productName ?? b.variantId
    const onHand = num(b.onHand ?? b.available)
    const available = num(b.available)
    const expiring = b.expiresAt ? new Date(b.expiresAt).getTime() - now <= 7 * 86400000 : false
    const status = b.state && b.state !== 'ACTIVE' ? 'quarantined' : expiring ? 'expiring' : onHand <= 5 ? 'low_stock' : 'in_stock'
    return {
      batch: mapBatch(b, storeId),
      variantName,
      sku: b.sku ?? b.batchCode,
      batchCode: b.batchCode,
      status,
      version: b.version ?? '',
      onHand,
      available,
    }
  })
  if (filters.status && filters.status !== 'all') stock = stock.filter((r) => r.status === filters.status)
  return stock
}
export interface LowStockRow {
  variantId: string
  name: string
  sku: string
  barcode: string | null
  onHand: number
  reserved: number
  available: number
  binLocation: string
  version: string
}
export async function listLowStock(storeId: string): Promise<LowStockRow[]> {
  const rows = await collect<BackendStockBalanceRow>((cursor) =>
    apiGet<Page<BackendStockBalanceRow>>(`/v1/store/inventory/low-stock?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=100`))
  return rows.map((row) => ({
    variantId: row.variantId,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    onHand: num(row.onHand),
    reserved: num(row.reserved),
    available: num(row.available),
    binLocation: row.binLocation ?? '',
    version: row.version,
  }))
}
export interface ExpiringStockRow {
  batchId: string
  variantId: string
  variantName: string
  batchCode: string
  expiresAt: string
  state: string
  onHand: number
  reserved: number
}
export async function listExpiringStock(storeId: string): Promise<ExpiringStockRow[]> {
  const [rows, stock] = await Promise.all([
    collect<BackendExpiringBatchRow>((cursor) =>
      apiGet<Page<BackendExpiringBatchRow>>(`/v1/store/inventory/expiring?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=100`)),
    collect<BackendBatchRow>((cursor) =>
      apiGet<Page<BackendBatchRow>>(`/v1/store/inventory/batches?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=100`)),
  ])
  const names = new Map(stock.map((b) => [b.variantId, b.name ?? b.variantName ?? b.productName ?? b.variantId]))
  return rows.map((row) => ({
    batchId: row.id,
    variantId: row.variantId,
    variantName: names.get(row.variantId) ?? row.variantId,
    batchCode: row.batchCode,
    expiresAt: row.expiresAt,
    state: row.state,
    onHand: num(row.onHand),
    reserved: num(row.reserved),
  }))
}
export async function listStoreReceipts(storeId: string): Promise<StockReceipt[]> {
  const rows = await collect<BackendReceiptRow>((cursor) =>
    apiGet<Page<BackendReceiptRow>>(`/v1/store/inventory/receipts?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  return rows.map((row) => mapReceipt(row, storeId))
}
export async function listStoreAdjustments(storeId: string): Promise<StockAdjustment[]> {
  const rows = await collect<BackendAdjustmentRow>((cursor) =>
    apiGet<Page<BackendAdjustmentRow>>(`/v1/store/inventory/adjustments?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  return rows.map((row) => mapAdjustment(row, storeId))
}
export async function listCountSessions(storeId: string): Promise<StockCount[]> {
  const rows = await collect<BackendCountSession>((cursor) =>
    apiGet<Page<BackendCountSession>>(`/v1/store/inventory/count-sessions?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  return rows.map(mapCountSession)
}
export async function createCountSession(storeId: string, note?: string): Promise<StockCount> {
  const row = await apiPost<BackendCountSession>('/v1/store/inventory/count-sessions', {
    storeId,
    ...(note?.trim() ? { note: note.trim() } : {}),
  })
  return mapCountSession(row)
}
export async function updateCountSession(
  sessionId: string,
  lines: Array<{ batchId: string; counted: string | null; reason?: string | null }>,
  expectedVersion?: string,
): Promise<StockCount> {
  const row = await apiPatch<BackendCountSession>(`/v1/store/inventory/count-sessions/${sessionId}`, {
    lines,
    ...(expectedVersion ? { expectedVersion } : {}),
  })
  return mapCountSession(row)
}
export async function cancelCountSession(sessionId: string): Promise<StockCount> {
  const row = await apiPost<BackendCountSession>(`/v1/store/inventory/count-sessions/${sessionId}/cancel`, {})
  return mapCountSession(row)
}
export async function listBinLocations(storeId: string): Promise<string[]> {
  const rows = await collect<BackendBatchRow>((cursor) =>
    apiGet<Page<BackendBatchRow>>(`/v1/store/inventory/batches?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=100`))
  return [...new Set(rows.map((r) => r.binLocation).filter((b): b is string => Boolean(b)))].sort()
}

// ── §4 Returns ─────────────────────────────────────────────────
export async function listEligibleReturnOrders(storeId: string): Promise<BackendEligibleReturnOrder[]> {
  return collect<BackendEligibleReturnOrder>((cursor) =>
    apiGet<Page<BackendEligibleReturnOrder>>(`/v1/store/returns?storeId=${storeId}&tab=ELIGIBLE${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
}
/** The feed is per return row; the portal inspects and drafts per order, so group here. */
export async function listRecordedReturns(storeId: string, filters: { search?: string } = {}): Promise<ReturnParcel[]> {
  const rows = await collect<BackendReturnRow>((cursor) =>
    apiGet<Page<BackendReturnRow>>(`/v1/store/returns?storeId=${storeId}&tab=RECORDED${filters.search ? `&search=${encodeURIComponent(filters.search)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  const groups = new Map<string, BackendReturnRow[]>()
  for (const row of rows) {
    const group = groups.get(row.orderId) ?? []
    group.push(row)
    groups.set(row.orderId, group)
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!
    const allProcessed = group.every((row) => row.status !== 'QUARANTINED')
    const anyInspected = group.some((row) => row.inspectedAt)
    const processed = group
      .map((row) => row.inspectedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1)
    const anyApproved = group.some((row) => row.status === 'APPROVED')
    return {
      id: first.orderId,
      orderId: first.orderId,
      orderNumber: first.orderNumber,
      customerName: first.customerName,
      storeId,
      returnedAt: first.createdAt,
      reason: mapReturnReason(first.failureReason ?? null) as ReturnReason,
      status: allProcessed ? 'processed' : anyInspected ? 'under_inspection' : 'pending',
      items: group.map((row) => ({
        variantId: row.variantId,
        name: row.variantName,
        icon: deriveIcon(row.variantName),
        qty: num(row.quantity),
        batchId: row.batchId ?? '',
        returnId: row.returnId,
        returnStatus: row.status,
        expiresAt: row.expiresAt ?? null,
        decision:
          row.status === 'APPROVED'
            ? 'saleable'
            : row.status === 'REJECTED'
              ? 'damaged'
              : undefined,
      })),
      stockAction: allProcessed ? (anyApproved ? 'quarantine' : 'write_off') : 'quarantine',
      note: first.reason ?? undefined,
      draft: false,
      processedAt: allProcessed ? processed : undefined,
    } satisfies ReturnParcel
  })
}
export async function getReturnOrderDetail(storeId: string, orderId: string): Promise<BackendReturnOrderDetail> {
  return apiGet<BackendReturnOrderDetail>(`/v1/store/returns/orders/${orderId}?storeId=${storeId}`)
}
export interface BackendInspectionDraft {
  orderId: string
  items: Array<{ variantId: string; quantity: string; decision: 'SALEABLE' | 'DAMAGED' | 'EXPIRED'; note: string | null }>
  note: string | null
  version: number
  updatedAt: string
}
export async function getReturnDraft(storeId: string, orderId: string): Promise<BackendInspectionDraft | null> {
  // An absent draft is a valid result; React Query requires null rather than undefined.
  return (await apiGet<BackendInspectionDraft | null | undefined>(`/v1/store/returns/orders/${orderId}/draft?storeId=${storeId}`)) ?? null
}
export async function saveReturnDraft(
  storeId: string,
  orderId: string,
  items: Array<{ variantId: string; quantity: string; decision: 'SALEABLE' | 'DAMAGED' | 'EXPIRED'; note: string | null }>,
  note: string | null,
): Promise<BackendInspectionDraft> {
  return apiPost<BackendInspectionDraft>(`/v1/store/returns/orders/${orderId}/draft`, { storeId, items, note })
}
export function parcelFromEligible(order: BackendEligibleReturnOrder, detail?: BackendReturnOrderDetail): ReturnParcel {
  return {
    id: `pending-${order.orderId}`,
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    storeId: '',
    returnedAt: order.failedAt ?? new Date().toISOString(),
    reason: mapReturnReason(order.failureReason),
    status: 'pending',
    items: (detail?.items ?? []).map((item) => ({
      variantId: item.variantId,
      name: item.variantName,
      icon: deriveIcon(item.variantName),
      qty: num(item.quantity),
      batchId: '',
      expiresAt: item.expiresAt,
    })),
    draft: false,
  }
}

// ── §5 Rider applications ──────────────────────────────────────
export async function listRiderApplicationsForStore(storeId: string, status?: string, search?: string): Promise<RiderApplication[]> {
  const upper = status && status !== 'all' ? status.toUpperCase() : undefined
  const allowed = upper && ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'].includes(upper) ? `&status=${upper}` : ''
  const rows = await collect<BackendRiderApplication>((cursor) =>
    apiGet<Page<BackendRiderApplication>>(`/v1/store/rider-applications?storeId=${storeId}${allowed}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  let apps = rows.map(mapRiderApplication)
  if (search) {
    const q = search.toLowerCase()
    apps = apps.filter((a) =>
      a.riderName.toLowerCase().includes(q) || a.phone.includes(q) || a.id.toLowerCase().includes(q) || a.vehicle.registration.toLowerCase().includes(q))
  }
  return apps.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
}
export async function getRiderApplication(storeId: string, userId: string): Promise<RiderApplication | null> {
  try {
    const row = await apiGet<BackendRiderApplication>(`/v1/store/rider-applications/${userId}?storeId=${storeId}`)
    return mapRiderApplication(row)
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

// ── §6 COD deposits ────────────────────────────────────────────
export async function listCodDeposits(storeId: string, filters: { search?: string } = {}): Promise<CodDeposit[]> {
  const doc = await apiGet<{ items: BackendCodDeposit[]; nextCursor: string | null; totals: { depositedPaise: string; discrepancyPaise: string; count: number } }>(
    `/v1/store/cod/deposits?storeId=${storeId}${filters.search ? `&search=${encodeURIComponent(filters.search)}` : ''}&limit=100`)
  return doc.items.map((row) => mapDeposit(row, storeId))
}
export async function getCodTotals(storeId: string): Promise<{ depositedPaise: string; discrepancyPaise: string; count: number }> {
  const doc = await apiGet<{ items: BackendCodDeposit[]; nextCursor: string | null; totals: { depositedPaise: string; discrepancyPaise: string; count: number } }>(
    `/v1/store/cod/deposits?storeId=${storeId}&limit=1`)
  return doc.totals
}
export async function listCodRiders(storeId: string): Promise<CodRider[]> {
  const rows = await collect<BackendCodRider>((cursor) =>
    apiGet<Page<BackendCodRider>>(`/v1/store/cod/riders?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`))
  return rows.map((row) => ({
    id: row.userId,
    name: row.name,
    cashInHand: num(row.cashInHandPaise) / 100,
    limitPaise: row.limitPaise === null ? null : num(row.limitPaise),
    hasOutstanding: row.hasOutstanding,
  }))
}

// ── §7 Store status ────────────────────────────────────────────
export async function getStoreStatusInfo(storeId: string): Promise<{ store: BackendStoreDetails; statusChanges: StoreStatusChange[] }> {
  const view = await apiGet<{ store: BackendStoreDetails; history: BackendStatusHistoryEntry[] }>(`/v1/store/status?storeId=${storeId}`)
  return {
    store: view.store,
    statusChanges: view.history.map((h) => mapStatusChange(h, storeId)),
  }
}

// ── §8 Staff & workload ────────────────────────────────────────
export interface StaffRow { id: string; name: string; email: string; status: string; activeTasks: number; overdueTasks: number; level: 'High' | 'Medium' | 'Low' }
export async function listStoreStaff(storeId: string): Promise<StaffRow[]> {
  const [staff, sla] = await Promise.all([
    apiGet<Page<BackendStaffMember>>(`/v1/store/staff?storeId=${storeId}&limit=100`),
    collect<BackendSlaTask>((cursor) =>
      apiGet<Page<BackendSlaTask>>(`/v1/store/sla-board?storeId=${storeId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=50`)),
  ])
  const now = Date.now()
  return staff.items.map((member) => {
    const mine = sla.filter((t) => t.assignedTo === member.userId && t.status !== 'PENDING')
    const overdue = mine.filter((t) => new Date(t.slaDueAt).getTime() < now).length
    return {
      id: member.userId,
      name: member.name,
      email: '',
      status: 'active',
      activeTasks: member.activeTasks,
      overdueTasks: overdue,
      level: overdue > 0 || member.activeTasks >= 4 ? 'High' : member.activeTasks >= 2 ? 'Medium' : 'Low',
    }
  })
}
export async function listEligibleAssignees(storeId: string, currentAssigneeId: string | null) {
  const staff = await listStoreStaff(storeId)
  return staff
    .filter((s) => s.id !== currentAssigneeId)
    .map((s) => ({ id: s.id, name: s.name, activeTasks: s.activeTasks }))
}

// ── §9 Notifications & account ─────────────────────────────────
const PREF_KEYS = ['pickingOrders', 'inventoryAlerts', 'riderApplications', 'codDeposits', 'storeStatus'] as const
/** Frontend toggles map onto delivery categories; STORE_OPS covers inventory alerts. */
const PREF_TO_CATEGORY: Record<(typeof PREF_KEYS)[number], string> = {
  pickingOrders: 'ORDER_UPDATES',
  inventoryAlerts: 'STORE_OPS',
  riderApplications: 'RIDING',
  codDeposits: 'PAYMENTS',
  storeStatus: 'ADMIN',
}
const CATEGORY_TO_PREF = Object.fromEntries(
  Object.entries(PREF_TO_CATEGORY).map(([key, category]) => [category, key]),
) as Record<string, (typeof PREF_KEYS)[number]>

export async function getStoreNotificationPrefs(_workforceId: string): Promise<StoreNotificationPrefs> {
  const rows = await apiGet<Array<{ category: string; enabled: boolean }>>('/v1/store/notification-preferences')
  const byCategory = new Map(rows.map((r) => [r.category, r.enabled]))
  const defaults: StoreNotificationPrefs = { pickingOrders: true, inventoryAlerts: true, riderApplications: true, codDeposits: true, storeStatus: true }
  for (const [category, key] of Object.entries(CATEGORY_TO_PREF)) {
    const enabled = byCategory.get(category)
    if (enabled !== undefined) defaults[key] = enabled
  }
  return defaults
}
export async function setStoreNotificationPrefs(prefs: StoreNotificationPrefs): Promise<void> {
  await apiPatch('/v1/store/notification-preferences', {
    updates: PREF_KEYS.map((key) => ({ category: PREF_TO_CATEGORY[key], enabled: prefs[key] })),
  })
}
export async function listStoreNotifications(storeId: string | null): Promise<StoreNotification[]> {
  const rows = await collect<BackendNotification>((cursor) =>
    apiGet<Page<BackendNotification>>(`/v1/store/notifications?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
  const scoped = storeId
    ? rows.filter((row) => !row.payload?.storeId || row.payload.storeId === storeId)
    : rows
  return scoped.map((row) => mapNotification(row, storeId))
}

export async function exportInventory(storeId: string, search = ''): Promise<{ items: Array<Record<string, string | null>>; truncated: boolean }> {
  const query = new URLSearchParams({ storeId })
  if (search) query.set('search', search)
  return apiGet(`/v1/store/inventory/export?${query.toString()}`)
}

export async function searchStore(storeId: string, type: 'ORDERS' | 'CUSTOMERS' | 'PRODUCTS', q: string) {
  const query = new URLSearchParams({ storeId, type, q, limit: '8' })
  return apiGet<{ items: Array<Record<string, unknown>> }>(`/v1/store/search?${query.toString()}`)
}
