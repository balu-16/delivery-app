/**
 * Backend → portal view-model adapters. The UI's shared types stay the
 * internal contract; these mappers translate the server's /v1/store shapes
 * (and its enum values) into them. Timestamps/ids/quantities come from the
 * server; nothing here invents operational data.
 */
import type {
  PickingTask, PickLine, PickingTaskStatus, ReturnParcel, ReturnReason, ReturnStatus,
  QualityDecision, RiderApplication, RiderApplicationDoc, CodDeposit, DepositOutcome,
  InventoryBatch, StockReceipt, StockCount, StockAdjustment, StoreStatusChange,
  StoreNotification, StoreNotificationKind, ProductIcon,
} from '@dairydirect/shared/types'

// ── backend response shapes (subset actually consumed) ─────────
export interface BackendPickItemView {
  id: string
  orderItemId: string
  variantId: string
  substituteVariantId: string | null
  name: string
  sku: string
  barcode: string | null
  expectedQty: string
  pickedQty: string
  batchId: string | null
  batchCode: string | null
  batchExpiresAt: string | null
  status: 'PENDING' | 'PICKED' | 'SHORT' | 'SUBSTITUTED'
  shortReason: 'OUT_OF_STOCK' | 'DAMAGED' | 'EXPIRED' | 'NOT_FOUND' | null
  fefoSuggestions: { batchId: string; batchCode: string; expiresAt: string | null; availableQty: string }[]
  substitutionCandidates: { variantId: string; name: string; sku: string; barcode: string | null; available: string }[]
}
export interface BackendPackingView {
  bags: number
  sealCode: string
  coldChain: boolean
  packedAt: string
  packedBy: string | null
}
export interface BackendHandoverView {
  state: 'PENDING' | 'VERIFIED' | 'OVERRIDE'
  riderId: string | null
  riderName: string | null
  attempts: number
  locked: boolean
  verifiedAt: string | null
  deliveryStatus: string | null
}
export interface BackendPickTaskView {
  id: string
  orderId: string
  orderNumber: string | null
  orderStatus: string
  customerName: string
  storeId: string
  status: 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  assignedTo: string | null
  assignedToName: string | null
  startedAt: string | null
  slaDueAt: string
  completedAt: string | null
  packing: BackendPackingView | null
  handover: BackendHandoverView | null
  deliveryStatus: string | null
  items: BackendPickItemView[]
}
export interface BackendStoreOrder {
  orderId: string
  orderNumber: string | null
  status: string
  itemCount: number
  placedAt: string | null
  pickTaskId: string | null
  pickTaskStatus: string | null
  customerName?: string
}
export interface BackendReturnRow {
  returnId: string
  orderId: string
  orderNumber: string
  customerName?: string
  failureReason?: string | null
  variantId: string
  variantName: string
  quantity: string
  status: 'QUARANTINED' | 'APPROVED' | 'REJECTED'
  reason: string | null
  createdAt: string
  inspectedAt: string | null
  batchId?: string | null
  expiresAt?: string | null
}
export interface BackendEligibleReturnOrder {
  orderId: string
  orderNumber: string
  customerName: string
  failureReason: string | null
  failedAt: string | null
  itemCount: number
  totalPaise: string
}
export interface BackendReturnOrderDetail {
  orderId: string
  orderNumber: string
  customerName: string
  status: string
  failureReason: string | null
  failedAt: string | null
  totalPaise: string
  items: { variantId: string; variantName: string; quantity: string; expiresAt: string | null }[]
  returns: BackendReturnRow[]
}
export interface BackendRiderApplication {
  userId: string
  name: string
  phone?: string | null
  email?: string | null
  status: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
  appliedAt?: string | null
  vehicleType?: string | null
  vehicleNo?: string | null
  homeStoreId?: string | null
  documents?: Array<{
    id: string
    documentType?: string
    type?: string
    status: 'PENDING' | 'APPROVED' | 'REJECTED'
    reviewedAt?: string | null
    reason?: string | null
    hasMedia?: boolean
  }>
}
export interface BackendCodDeposit {
  id: string
  riderId: string
  riderName: string
  amountPaise: string
  discrepancyPaise: string
  depositReference: string
  status: string
  createdAt: string
}
export interface BackendCodRider {
  userId: string
  name: string
  cashInHandPaise: string
  limitPaise: string | null
  hasOutstanding: boolean
}
export interface BackendBatchRow {
  batchId: string
  storeId?: string
  variantId: string
  variantName?: string
  name?: string
  sku?: string
  productName?: string
  batchCode: string
  expiresAt: string | null
  state?: string
  onHand?: string
  reserved?: string
  available: string
  binLocation: string | null
  version?: string
}
export interface BackendStockBalanceRow {
  variantId: string
  sku: string
  barcode: string | null
  name: string
  onHand: string
  reserved: string
  available: string
  binLocation: string | null
  version: string
}
export interface BackendExpiringBatchRow {
  id: string
  variantId: string
  batchCode: string
  expiresAt: string
  state: string
  onHand: string
  reserved: string
}
export interface BackendReceiptRow {
  id: string
  reference: string
  variantId: string
  variantName: string
  sku?: string
  batchId?: string
  batchCode?: string
  expiresAt?: string | null
  quantity: string
  createdAt: string
  actorName?: string | null
}
export interface BackendAdjustmentRow {
  reference: string
  counted?: string
  delta: string | null
  variantId: string | null
  variantName?: string | null
  batchId?: string | null
  batchCode?: string | null
  reason: string | null
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'APPLIED' | string
  actorName?: string | null
  createdAt: string
}
export interface BackendCountSessionLine {
  lineNo: number
  variantId: string
  variantName: string
  sku: string
  batchId: string
  batchCode: string
  expiresAt: string | null
  expectedQty: string
  countedQty: string | null
  reason: string | null
  outcome: 'APPLIED' | 'PENDING_APPROVAL' | 'FAILED' | null
  outcomeDetail: string | null
}
export interface BackendCountSession {
  id: string
  storeId: string
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED'
  note: string | null
  version: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  lines: BackendCountSessionLine[]
}
export interface BackendStoreDetails {
  storeId: string
  name: string
  status: 'ONLINE' | 'PAUSED' | 'OFFLINE'
  pauseReason: string | null
  version: string
  location: { lat: number; lng: number } | null
  hourlyCapacity: number
  lastOrderBufferMinutes: number
  hours: Array<{ weekday: number; startMinute: number; endMinute: number }>
}
export interface BackendStatusHistoryEntry {
  version: string
  previousStatus: string
  status: string
  reason: string | null
  actorId: string | null
  occurredAt: string
}
export interface BackendNotification {
  id: string
  channel: string
  templateKey: string
  category: string
  payload: { body?: string; title?: string; storeId?: string; [k: string]: unknown }
  readAt: string | null
  createdAt: string
}
export interface BackendStaffMember {
  userId: string
  name: string
  role: string
  activeTasks: number
}
export interface BackendKpis {
  openTasks: number
  completedToday: number
  slaBreachesToday: number
  avgPickSeconds: string
  shortRateBps: string
  backlog: number
}
export interface BackendSlaTask {
  id: string
  orderId: string
  status: 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS'
  assignedTo: string | null
  slaDueAt: string
  breached: boolean
}

// ── helpers ─────────────────────────────────────────────────────
export function num(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value ?? NaN)
  return Number.isFinite(n) ? n : 0
}

const ICONS: ProductIcon[] = ['milk', 'curd', 'paneer', 'butter', 'ghee', 'lassi', 'buttermilk', 'cream']
export function deriveIcon(name: string): ProductIcon {
  const lower = name.toLowerCase()
  const match = ICONS.find((icon) => lower.includes(icon))
  return match ?? 'milk'
}

export function mapTaskStatus(status: BackendPickTaskView['status'], orderStatus?: string): PickingTaskStatus {
  if (orderStatus === 'PACKED') return 'ready_for_handover'
  if (orderStatus === 'OUT_FOR_DELIVERY' || orderStatus === 'DELIVERED' || orderStatus === 'RETURNED_TO_STORE') return 'completed'
  switch (status) {
    case 'PENDING': return 'waiting_to_pick'
    case 'ASSIGNED':
    case 'IN_PROGRESS': return 'being_picked'
    case 'COMPLETED': return 'ready_to_pack'
    default: return 'cancelled'
  }
}

export function mapTask(view: BackendPickTaskView, order?: BackendStoreOrder): PickingTask {
  const lines: PickLine[] = view.items.map((item) => ({
    id: item.id,
    variantId: item.substituteVariantId ?? item.variantId,
    name: item.name,
    icon: deriveIcon(item.name),
    sku: item.sku,
    barcode: item.barcode,
    qtyOrdered: num(item.expectedQty),
    qtyPicked: num(item.pickedQty),
    batchId: item.batchId ?? item.fefoSuggestions[0]?.batchId ?? '',
    batchCode: item.batchCode ?? item.fefoSuggestions[0]?.batchCode ?? '',
    batchExpiry: item.batchExpiresAt ?? item.fefoSuggestions[0]?.expiresAt ?? '',
    substitutionVariantId: item.substituteVariantId ?? undefined,
    unavailableReason: item.shortReason ?? undefined,
    resolved: item.status !== 'PENDING',
    substitutionCandidates: (item.substitutionCandidates ?? []).map((candidate) => ({
      variantId: candidate.variantId,
      name: candidate.name,
      sku: candidate.sku,
      barcode: candidate.barcode,
      available: num(candidate.available),
    })),
  }))
  return {
    id: view.id,
    orderId: view.orderId,
    orderNumber: view.orderNumber ?? order?.orderNumber ?? null,
    orderStatus: view.orderStatus ?? order?.status,
    customerName: view.customerName || order?.customerName || undefined,
    storeId: view.storeId,
    status: mapTaskStatus(view.status, view.orderStatus ?? order?.status),
    assigneeId: view.assignedTo,
    assigneeName: view.assignedToName,
    claimedAt: view.startedAt ?? undefined,
    deadline: view.slaDueAt,
    createdAt: order?.placedAt ?? view.startedAt ?? view.slaDueAt,
    lines,
    packing: view.packing
      ? {
          bags: view.packing.bags,
          coldChain: view.packing.coldChain,
          packedBy: view.packing.packedBy ?? 'Store manager',
          sealCode: view.packing.sealCode,
          packedAt: view.packing.packedAt,
        }
      : undefined,
    handover: view.handover
      ? {
          state: view.handover.state,
          riderId: view.handover.riderId,
          riderName: view.handover.riderName,
          attempts: view.handover.attempts,
          locked: view.handover.locked,
          verifiedAt: view.handover.verifiedAt ?? undefined,
          deliveryStatus: view.handover.deliveryStatus,
        }
      : undefined,
    deliveryStatus: view.deliveryStatus,
    completedAt: view.completedAt ?? undefined,
  }
}

const FAILURE_REASON_TO_RETURN: Record<string, ReturnReason> = {
  CUSTOMER_UNAVAILABLE: 'customer_unavailable',
  WRONG_ADDRESS: 'wrong_address',
  DELIVERY_REFUSED: 'delivery_refused',
  RIDER_COULD_NOT_DELIVER: 'rider_could_not_deliver',
}
export function mapReturnReason(failureReason: string | null): ReturnReason {
  if (!failureReason) return 'other'
  return FAILURE_REASON_TO_RETURN[failureReason] ?? 'other'
}

export function mapReturnStatus(status: BackendReturnRow['status'], inspected: boolean): ReturnStatus {
  if (status === 'APPROVED' || status === 'REJECTED') return 'processed'
  return inspected ? 'under_inspection' : 'pending'
}

export function mapDecision(decision: 'SALEABLE' | 'DAMAGED' | 'EXPIRED'): QualityDecision {
  return decision.toLowerCase() as QualityDecision
}
export function toBackendDecision(decision: QualityDecision): 'SALEABLE' | 'DAMAGED' | 'EXPIRED' {
  return decision.toUpperCase() as 'SALEABLE' | 'DAMAGED' | 'EXPIRED'
}

export function mapReturnParcel(
  row: BackendReturnRow,
  failureReason: string | null,
  context: { storeId?: string; orderNumber?: string; customerName?: string } = {},
): ReturnParcel {
  return {
    id: row.returnId,
    orderId: row.orderId,
    orderNumber: context.orderNumber ?? row.orderNumber,
    customerName: context.customerName ?? row.customerName,
    storeId: context.storeId ?? '',
    returnedAt: row.createdAt,
    reason: mapReturnReason(failureReason ?? row.failureReason ?? null),
    status: mapReturnStatus(row.status, Boolean(row.inspectedAt)),
    items: [
      {
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
      },
    ],
    stockAction:
      row.status === 'APPROVED'
        ? 'quarantine'
        : row.status === 'REJECTED'
          ? 'write_off'
          : undefined,
    note: row.reason ?? undefined,
    draft: false,
    processedAt: row.inspectedAt ?? undefined,
  }
}

export function mapRiderStatus(status: BackendRiderApplication['status']): RiderApplication['status'] {
  const lowered = status.toLowerCase()
  // SUSPENDED folds into rejected for the portal's list filter buckets.
  return (lowered === 'suspended' ? 'rejected' : lowered) as RiderApplication['status']
}

export function mapRiderApplication(row: BackendRiderApplication): RiderApplication {
  const documents: RiderApplicationDoc[] = (row.documents ?? []).map((doc) => {
    const documentType = doc.documentType ?? doc.type ?? 'license'
    return {
      id: doc.id,
      type: documentType as RiderApplicationDoc['type'],
      label: documentType.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
      number: doc.id.slice(0, 8).toUpperCase(),
      status: doc.status.toLowerCase() as RiderApplicationDoc['status'],
      decidedAt: doc.reviewedAt ?? undefined,
      reason: doc.reason ?? undefined,
    }
  })
  return {
    id: row.userId,
    storeId: row.homeStoreId ?? '',
    riderName: row.name,
    phone: row.phone ?? '',
    email: row.email ?? '',
    vehicle: {
      type: row.vehicleType ?? 'bike',
      makeModel: '',
      registration: row.vehicleNo ?? '',
      color: '',
      year: 0,
    },
    appliedAt: row.appliedAt ?? row.documents?.[0]?.reviewedAt ?? new Date(0).toISOString(),
    status: mapRiderStatus(row.status) as RiderApplication['status'],
    documents,
  }
}

export function mapDepositOutcome(discrepancyPaise: string, status: string): DepositOutcome {
  if (status.toLowerCase() === 'pending') return 'pending_verification'
  return num(discrepancyPaise) === 0 ? 'received' : 'discrepancy'
}

export function mapDeposit(row: BackendCodDeposit, storeId: string): CodDeposit {
  return {
    id: row.id,
    storeId,
    riderId: row.riderId,
    riderName: row.riderName,
    amount: num(row.amountPaise) / 100,
    reference: row.depositReference,
    outcome: mapDepositOutcome(row.discrepancyPaise, row.status),
    remarks: num(row.discrepancyPaise) !== 0 ? `Discrepancy ₹${(num(row.discrepancyPaise) / 100).toFixed(2)}` : undefined,
    at: row.createdAt,
  }
}

export function mapBatch(row: BackendBatchRow, storeId: string): InventoryBatch {
  return {
    id: row.batchId,
    storeId,
    variantId: row.variantId,
    qty: num(row.onHand ?? row.available),
    expiryDate: row.expiresAt ?? '',
    binLocation: row.binLocation ?? '',
  }
}

export function mapReceipt(row: BackendReceiptRow, storeId: string): StockReceipt {
  return {
    id: row.id,
    storeId,
    variantId: row.variantId,
    batchNo: row.batchCode ?? row.reference,
    expiryDate: row.expiresAt ?? '',
    qty: num(row.quantity),
    binLocation: '',
    at: row.createdAt,
    by: row.actorName ?? 'Store manager',
  }
}

export function mapCountSession(row: BackendCountSession): StockCount {
  return {
    id: row.id,
    storeId: row.storeId,
    startedAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
    status: row.status === 'OPEN' ? 'open' : row.status === 'COMPLETED' ? 'completed' : 'cancelled',
    note: row.note ?? undefined,
    version: row.version,
    lines: row.lines.map((line) => ({
      id: `${row.id}:${line.lineNo}`,
      batchId: line.batchId,
      batchCode: line.batchCode,
      variantId: line.variantId,
      name: line.variantName,
      expected: num(line.expectedQty),
      counted: line.countedQty === null ? null : num(line.countedQty),
      reason: line.reason,
      outcome: line.outcome,
      outcomeDetail: line.outcomeDetail,
    })),
  }
}

export function mapAdjustment(row: BackendAdjustmentRow, storeId: string): StockAdjustment {
  return {
    id: row.reference,
    storeId,
    variantId: row.variantId ?? '',
    delta: num(row.delta),
    reason: row.reason ?? '',
    by: row.actorName ?? 'Store manager',
    at: row.createdAt,
    approvalStatus:
      row.state === 'APPROVED' || row.state === 'APPLIED'
        ? 'approved'
        : row.state === 'REJECTED' || row.state === 'EXPIRED'
          ? 'rejected'
          : 'pending',
  }
}

export function mapStatusChange(row: BackendStatusHistoryEntry, storeId: string): StoreStatusChange {
  return {
    id: row.version,
    storeId,
    status: row.status.toLowerCase() === 'paused' ? 'paused' : 'online',
    by: row.actorId ?? 'system',
    role: 'Store manager',
    at: row.occurredAt,
    reason: row.reason ?? undefined,
  }
}

const TEMPLATE_TITLES: Record<string, string> = {
  store_order_arrived: 'New order arrived',
  picking_sla_warning: 'Picking SLA warning',
  inventory_low_stock: 'Low stock alert',
  cod_deposit_received: 'COD deposit received',
  delivery_returned_to_store: 'Parcel returned to store',
}
export function mapNotification(row: BackendNotification, storeId: string | null): StoreNotification {
  const kind: StoreNotificationKind = row.category === 'ADMIN' || row.category === 'PROMOTIONS' ? 'system' : 'operational'
  return {
    id: row.id,
    storeId: row.payload.storeId ?? storeId,
    title: row.payload.title ?? TEMPLATE_TITLES[row.templateKey] ?? row.templateKey.replaceAll('_', ' '),
    body: row.payload.body ?? '',
    kind,
    requiresAction: false,
    read: row.readAt !== null,
    at: row.createdAt,
  }
}

export function mapStaffLevel(activeTasks: number, overdueTasks: number): 'High' | 'Medium' | 'Low' {
  if (overdueTasks > 0 || activeTasks >= 4) return 'High'
  if (activeTasks >= 2) return 'Medium'
  return 'Low'
}
