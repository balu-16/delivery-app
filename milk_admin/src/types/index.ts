// ── Domain types for DairyDirect Admin — REAL BACKEND SHAPES ─────────────────
// Types here are honest projections of the NestJS admin API (see src/api/*).
// Backend conventions: paise STRINGS for money, ISO UTC timestamps,
// UPPER_SNAKE_CASE enums (mapped to lowercase here), UUID ids, cursor pages.

// ── Shared primitives ────────────────────────────────────────────────────────
/** Generic cursor page returned by list endpoints. */
export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export interface AuthAdmin {
  userId: string
  email: string
  name: string
  role: 'ADMIN'
}

// ── §2 Stores & service areas (serviceability surface) ──────────────────────
export type StoreStatus = 'online' | 'paused' | 'offline'

export interface City {
  id: string
  name: string
  /** GeoJSON Polygon bounding the city (WGS84) — passed through to the map. */
  bounds: object
  zoneVersion: string
}

/** Legal entity — the backend carries only id + name. */
export interface LegalEntity {
  id: string
  name: string
}

export interface Store {
  id: string
  name: string
  legalEntityId: string
  cityId: string
  status: StoreStatus
  pauseReason: string | null
  hourlyCapacity: number
  lastOrderBufferMinutes: number
  acceptsCod: boolean
  lat: number
  lng: number
  version: string
}

export interface StoreHoursRow { weekday: number; startMinute: number; endMinute: number }
export interface StoreHolidayRow { day: string; closed: boolean }
export interface StoreHolidayHoursRow { day: string; startMinute: number; endMinute: number }
export interface StoreStaffRow { userId: string; role: 'STORE_MANAGER' }

export interface StoreOperations {
  hours: StoreHoursRow[]
  holidays: StoreHolidayRow[]
  holidayHours: StoreHolidayHoursRow[]
  staff: StoreStaffRow[]
  nextHolidayCursor: string | null
  nextStaffCursor: string | null
}

export interface Zone {
  id: string
  storeId: string
  name: string
  priority: number
  active: boolean
  version: string
  /** GeoJSON Polygon/MultiPolygon (WGS84) — edited via PolygonEditor. */
  geometry: object
}

// ── §3 Products & pricing (catalog surface) ──────────────────────────────────
export type Category = { id: string; name: string }
export type Brand = { id: string; name: string }

export interface Product {
  id: string
  name: string
  categoryId: string
  brandId: string | null
  description: string
  hsnCode: string | null
  gstRateBps: number | null
  perishable: boolean
  expiryTracking: boolean
  published: boolean
}

export type VariantBaseUnit = 'PIECE' | 'GRAM' | 'MILLILITRE'

export interface Variant {
  id: string
  productId: string
  name: string
  baseUnit: VariantBaseUnit
  sku: string
  barcode: string | null
}

export interface PriceResult {
  approvalId?: string
}

// ── §4 Inventory ─────────────────────────────────────────────────────────────
export interface StockRow {
  variantId: string
  sku: string | null
  name: string | null
  onHand: number
  reserved: number
  available: number
  version: string | null
}

/** Cross-store summary row (GET /v1/admin/inventory/summary — pinned new endpoint). */
export interface InventorySummaryRow {
  variantId: string
  sku: string
  name: string
  units: number
  availableStores: number
  lowStockStores: number
  totalReserved: number
}

export interface LedgerRow {
  id: string
  reference: string
  variantId: string
  batchId: string
  kind: string
  onHandDelta: number
  reservedDelta: number
  actorId: string | null
  createdAt: string
}

export interface ExpiringBatch {
  id: string
  variantId: string
  batchCode: string
  expiresAt: string
  state: 'ACTIVE' | 'QUARANTINED' | 'DAMAGED'
  onHand: number
  reserved: number
}

export interface ShelfLifePolicy {
  categoryId: string
  minSeconds: number
  version: string
}

// ── §5 Orders & delivery ─────────────────────────────────────────────────────
export type OrderStatus =
  | 'pending_payment' | 'confirmed' | 'picking' | 'packed' | 'out_for_delivery'
  | 'delivered' | 'cancelled' | 'expired' | 'delivery_failed' | 'returned_to_store'
  | 'payment_failed'

export type OrderPaymentMethod = 'gateway' | 'wallet' | 'cod' | 'zero_due'
export type OrderPaymentStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded' | 'cod_pending' | 'cod_collected'

export interface OrderItem {
  id: string
  variantId: string
  name: string
  qty: number
  unitPrice: number // rupees
  lineStatus: string
}

export interface OrderFeeLine {
  kind: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE' | 'TIP'
  amount: number
}

export interface OrderHold {
  held: boolean
  reason: string | null
  actorId: string | null
  heldAt: string | null
}

export interface Order {
  id: string
  orderNumber: string
  userId: string
  storeId: string
  status: OrderStatus
  onHold: boolean
  paymentStatus: OrderPaymentStatus
  paymentMethod: OrderPaymentMethod | null
  subtotal: number // rupees
  discount: number
  feeTotal: number
  taxTotal: number
  tip: number
  total: number
  amountDue: number
  currency: string
  placedAt: string
  expiresAt: string | null
  confirmedAt: string | null
  deliveredAt: string | null
  cancelReason: string | null
  items: OrderItem[]
  fees: OrderFeeLine[]
}

export interface OrderDetailData extends Order {
  hold: OrderHold
}

export interface TimelineEntry {
  previousState: string | null
  state: string
  action: string
  actorType: string
  actorId: string | null
  reason: string | null
  at: string
}

export interface OrderPaymentAttempt {
  attemptId: string
  orderId: string
  operationReference: string
  kind: 'ORDER_PAYMENT' | 'WALLET_TOPUP' | 'ORDER_REFUND' | 'WALLET_REFUND'
  gatewayOrderId: string | null
  gatewayPaymentId: string | null
  amount: number // rupees
  currency: string
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'unknown'
  createdAt: string
}

export interface OrderRefund {
  refundId: string
  refundReference: string
  orderId: string
  sourceType: 'GATEWAY_CAPTURE' | 'WALLET_DEBIT' | 'COD_COLLECTION'
  sourceId: string
  amount: number // rupees
  destination: 'GATEWAY' | 'WALLET' | 'MANUAL_PAYOUT'
  status: 'pending' | 'processed' | 'failed' | 'unknown'
  gatewayRefundId: string | null
  reason: string | null
}

export interface RiderCandidate {
  riderId: string
  name: string
  eligible: boolean
  reason: string | null
}

export interface InvoiceInfo {
  url: string
  expiresIn: number
  documentId: string
  number: string
}

export interface FleetRider {
  riderId: string
  name: string
  storeId: string
  availability: 'AVAILABLE' | 'ON_DELIVERY' | 'OFFLINE' | 'UNKNOWN'
  lastLocation: { lat: number; lng: number } | null
  lastUpdateAt: string
  fresh: boolean
}

export interface FleetSnapshot {
  items: FleetRider[]
  freshnessSeconds: number
}

// ── §6 People ────────────────────────────────────────────────────────────────
export type UserPool = 'CUSTOMER' | 'WORKFORCE'
export type AccountStatus = 'active' | 'blocked' | 'deleted'

export interface AdminUser {
  userId: string
  email: string
  name: string
  pool: UserPool
  status: AccountStatus
  roles: string[]
}

export interface WorkforceAccount {
  userId: string
  email: string
  name: string
  status: AccountStatus
  roles: string[]
  /** STORE_MANAGER assignments when listed with store context. */
  storeIds: string[]
}

export type RiderApplicationStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'suspended'

export interface RiderApplicationListItem {
  userId: string
  name: string
  email: string
  status: RiderApplicationStatus
}

export interface RiderApplicationDocument {
  id: string
  type: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string | null
  createdAt: string
}

export interface RiderApplicationDetail {
  userId: string
  status: RiderApplicationStatus
  vehicleType: string | null
  vehicleNo: string | null
  homeStoreId: string | null
  requiredDocuments: string[]
  documents: RiderApplicationDocument[]
}

// ── §7 Payments, refunds & wallets ───────────────────────────────────────────
export interface PaymentAttempt {
  attemptId: string
  orderId: string
  operationReference: string
  kind: string
  gatewayPaymentId: string | null
  amount: number
  currency: string
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'unknown'
  createdAt: string
}

export interface RefundRow {
  refundId: string
  refundReference: string
  orderId: string
  sourceType: string
  amount: number
  destination: string
  status: 'pending' | 'processed' | 'failed' | 'unknown'
  gatewayRefundId: string | null
  reason: string | null
}

export type WalletBucket = 'cash' | 'promo'
export type WalletReason =
  | 'ORDER_PAYMENT' | 'ORDER_PAYMENT_REVERSAL' | 'TOPUP_CREDIT' | 'PROMO_GRANT'
  | 'PROMO_EXPIRY' | 'REFUND_CREDIT' | 'ADMIN_ADJUSTMENT'

export interface WalletLedgerRow {
  id: string
  userId: string
  bucket: WalletBucket
  delta: number // signed rupees
  reason: WalletReason
  refType: string
  refId: string
  balanceAfter: number
  createdAt: string
}

export type ReconciliationStatus = 'open' | 'acknowledged' | 'escalated' | 'resolved' | 'rejected' | 'dismissed'

export interface ReconciliationFinding {
  id: string
  kind: string
  severity: string
  aggregateType: string
  aggregateId: string
  reference: string
  details: Record<string, unknown>
  status: ReconciliationStatus
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string
}

export interface InvoiceRenderFailure {
  documentId: string
  number: string
  attempts: number
  suspendedAt: string
}

// ── §8 Rider payouts & COD ───────────────────────────────────────────────────
export type PayoutStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'cancelled' | 'settled_zero'

export interface Payout {
  id: string
  riderId: string
  riderName: string | null
  gross: number
  cashOffset: number
  net: number
  status: PayoutStatus
  createdAt: string
  approvedAt: string | null
  paidAt: string | null
}

export interface PayoutCorrection {
  id: string
  payoutId: string
  delta: number // signed rupees (positive owed to rider)
  reason: string
  state: string
  createdAt: string
  settledAt: string | null
  paymentReference: string | null
}

export interface UploadTarget {
  mediaId: string
  url: string
  fields: Record<string, string>
}

// ── §9 Offers & notifications ────────────────────────────────────────────────
export type CouponKind = 'percent' | 'flat' | 'free_delivery'

export interface Coupon {
  id: string
  code: string
  kind: CouponKind
  /** percent → bps value; flat → paise as rupees. */
  value: number
  maxCap: number | null
  minOrder: number
  perUserLimit: number | null
  globalLimit: number | null
  validFrom: string | null
  validTo: string | null
  storeId: string | null
  categoryId: string | null
  productId: string | null
  stackable: boolean
  firstOrderOnly: boolean
  active: boolean
  version: string
}

export type CampaignTargetMode = 'all' | 'users' | 'platform'

export interface PushCampaignPreview {
  target: { mode: CampaignTargetMode; apps: string[]; userIds?: string[]; platform?: string }
  kind: 'promotional' | 'operational'
  estimatedRecipients: number | null
}

export interface PushCampaign {
  id: string
  title: string
  body: string
  kind: 'promotional' | 'operational'
  target: { mode: CampaignTargetMode; apps: string[] }
  recipients: number | null
  createdAt: string
}

export type NotificationCategory = 'ORDER_UPDATES' | 'PAYMENTS' | 'WALLET' | 'RIDING' | 'STORE_OPS' | 'ADMIN' | 'PROMOTIONS'

export interface AdminNotification {
  id: string
  channel: 'PUSH' | 'EMAIL' | 'INBOX'
  templateKey: string
  title: string
  body: string
  category: NotificationCategory
  class: 'TRANSACTIONAL' | 'PROMOTIONAL'
  readAt: string | null
  createdAt: string
}

export interface NotificationPreference {
  category: NotificationCategory
  enabled: boolean
}

// ── §10 Subscriptions ────────────────────────────────────────────────────────
export interface SubscriptionPlan {
  variantId: string
  active: boolean
  version: string
}

export interface DeliverySlot {
  id: string
  storeId: string
  name: string
  startTime: string
  endTime: string
  active: boolean
  version: string
}

export interface SubscriptionHoliday {
  storeId: string
  date: string
  reason: string | null
}

export interface SubscriptionRun {
  id: string
  storeId: string | null
  runDate: string | null
  status: string
  generatedCount: number | null
  failedCount: number | null
  lastError: string | null
  createdAt: string
}

// ── §11 Support & reviews ────────────────────────────────────────────────────
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export interface TicketListItem {
  id: string
  orderId: string | null
  category: string
  status: TicketStatus
  assigneeId: string | null
  createdAt: string
  updatedAt: string | null
}

export interface TicketMessageRow {
  id: string
  authorId: string
  isOwner: boolean // author is the ticket owner (customer side)
  body: string
  internal: boolean
  createdAt: string
  attachments: string[] // media ids
}

export interface TicketDetail {
  ticket: TicketListItem & { ownerId: string; firstResponseDueAt?: string | null; resolutionDueAt?: string | null }
  messages: TicketMessageRow[]
  nextMessagesCursor: string | null
}

export interface SavedResponse {
  id: string
  label: string
  body: string
}

export type ModerationDecision = 'hidden' | 'visible'

export interface RatingRow {
  id: string
  targetType: 'ORDER' | 'RIDER' | 'PRODUCT'
  targetId: string
  stars: number
  comment: string | null
  hidden: boolean
  needsModeration: boolean
  createdAt: string
}

// ── §12 Reports & exports ────────────────────────────────────────────────────
export type ReportKind = 'catalog' | 'stock' | 'financial' | 'picking' | 'rider' | 'subscription' | 'support'
export type ExportJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'expired'

export interface ReportPreviewRow {
  [key: string]: unknown
}

export interface ReportPreview {
  items: ReportPreviewRow[]
  nextCursor: string | null
}

export interface ExportJob {
  id: string
  kind: string
  status: ExportJobStatus
  rowCount: number
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

// ── §13 Approvals & compliance ───────────────────────────────────────────────
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface Approval {
  id: string
  action: string
  makerId: string
  checkerId: string | null
  requiredRole: string
  status: ApprovalStatus
  expiresAt: string
  createdAt: string
}

export type FraudReviewDecision = 'acknowledged' | 'dismissed' | 'escalated' | 'resolved' | 'rejected'

export interface FraudSignal {
  id: string
  kind: string
  severity: string
  status: string
  createdAt: string
}

export interface FraudSignalDetail extends FraudSignal {
  userId: string | null
  reference: string
  details: Record<string, unknown>
  reviewedBy: string | null
  reviewedAt: string | null
}

export type ErasureStatus = 'pending' | 'processing' | 'completed' | 'rejected' | 'failed'

export interface ErasureRequest {
  id: string
  userId: string
  status: ErasureStatus
  blockers: string[]
  createdAt: string
  updatedAt: string
}

export interface LegalHold {
  id: string
  userId: string
  reason: string
  createdAt: string
  releasedAt: string | null
}

export interface FailedJob {
  id: string
  name: string
  attempts: number
  failedAt: string | null
}

export interface OutboxStatus {
  pending: number
  suspended: number
  oldestPending: string | null
  latestProcessed: string | null
}

// ── §14 Settings & system ────────────────────────────────────────────────────
export interface FeatureFlags {
  cod: boolean
  wallets: boolean
  subscriptions: boolean
}

export interface ConfigSnapshot {
  config: Record<string, unknown>
  flags: Record<string, boolean>
}

export interface BackgroundJob {
  id: string
  name: string
  attempts: number
  failedAt: string | null
}

// ── Global search (GET /v1/admin/search — pinned new endpoint) ───────────────
export interface SearchHit {
  id: string
  title: string
  sub?: string | null
}

export interface SearchGroup {
  group: string
  items: SearchHit[]
}

// ── Dashboard (GET /v1/admin/dashboard — pinned new endpoint) ────────────────
export interface DashboardData {
  period: { from: string; to: string }
  invoicedSalesPaise: string | null
  creditNotesPaise: string | null
  refundsProcessedPaise: string | null
  walletTopUpsPaise: { total: string | null } | null
  orders: {
    placed: number | null
    confirmed: number | null
    picking: number | null
    packed: number | null
    outForDelivery: number | null
    delivered: number | null
    cancelled: number | null
    expired: number | null
    onHold: number | null
  } | null
  stores: { total: number | null; online: number | null } | null
  customers: { total: number | null; active: number | null } | null
}

// ── Range keys shared by dashboard/orders/reports filters ────────────────────
export type RangeKey = 'today' | '7d' | '30d' | '90d'

// ── Shared utility types (charts, product glyphs) ────────────────────────────
export type ProductIcon = 'milk' | 'paneer' | 'ghee' | 'curd' | 'butter' | 'lassi' | 'buttermilk' | 'cream' | 'cheese' | 'khoya' | 'flavored_milk'

export interface StatusSlice {
  key: string
  label: string
  value: number
  color: string
}
