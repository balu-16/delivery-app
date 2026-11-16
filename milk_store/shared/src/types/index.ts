// ── Domain types for DairyDirect Admin (spec: "Admin sidebar", 14 sections) ──

// Enums
export type StoreStatus = 'online' | 'paused'
export type ZonePriority = 1 | 2 | 3
export type ProductCategory = { id: string; name: string }
export type Brand = { id: string; name: string }
export type PublishState = 'published' | 'unpublished'
export type VariantAvailability = { variantId: string; storeId: string; available: boolean; priceOverride: number | null }
export type MovementType = 'receipt' | 'sale' | 'adjustment' | 'damage' | 'expiry' | 'transfer'
export type FlagReason = 'unusual_adjustment' | 'damage' | 'expiry'
export type OrderStatus = 'placed' | 'confirmed' | 'picking' | 'ready' | 'out_for_delivery' | 'delivered' | 'cancelled' | 'on_hold'
export type PaymentMethod = 'online_upi' | 'online_card' | 'online_netbanking' | 'wallet' | 'cod'
export type PaymentAttemptStatus = 'captured' | 'failed' | 'initiated'
export type RefundStatus = 'requested' | 'processing' | 'paid' | 'failed'
export type RefundSource = 'admin' | 'support' | 'system' | 'customer'
export type WalletEntryType = 'topup' | 'order_payment' | 'refund_credit' | 'adjustment'
export type RiderStatus = 'application_pending' | 'application_approved' | 'application_rejected' | 'active' | 'suspended'
export type DocStatus = 'pending' | 'submitted' | 'verified' | 'rejected'
export type WorkforceRole = 'admin' | 'store_manager' | 'rider' | 'support_agent'
export type AccountStatus = 'active' | 'blocked' | 'invited' | 'inactive'
export type PayoutStatus = 'pending_review' | 'approved' | 'processing' | 'paid' | 'failed' | 'on_hold'
export type CouponKind = 'percentage' | 'flat' | 'free_delivery'
export type CouponStatus = 'active' | 'inactive' | 'scheduled' | 'expired'
export type CampaignAudience = 'all_customers' | 'subscription_users' | 'selected_users'
export type CampaignStatus = 'draft' | 'scheduled' | 'sent'
export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed'
export type TicketCategory = 'order_issue' | 'payment' | 'refund_request' | 'account' | 'product_quality' | 'other'
export type ModerationStatus = 'pending' | 'approved' | 'removed'
export type ApprovalStatus = 'pending' | 'completed' | 'rejected' | 'expired'
export type ExportJobStatus = 'pending' | 'complete' | 'failed'
export type FindingStatus = 'open' | 'investigating' | 'resolved'
export type FraudStatus = 'open' | 'cleared' | 'confirmed'
export type JobStatus = 'failed' | 'running' | 'completed' | 'retrying'
export type RunStatus = 'completed' | 'partial' | 'failed'
export type ErasureStatus = 'pending' | 'processing' | 'completed' | 'rejected'
export type RangeKey = 'today' | '7d' | '30d' | '90d'

// ── §2 Stores & service areas ────────────────────────────────
export interface City { id: string; name: string; coords: [number, number] }

export interface LegalEntity {
  id: string
  name: string
  gstin: string
  address: string
  invoicePrefix: string
}

export interface StoreHours { day: number; open: string | null; close: string | null } // day 0=Sun; null = closed
export interface StoreHoliday { date: string; name: string }

export interface Store {
  id: string
  code: string
  name: string
  location: string
  cityId: string
  coords: [number, number]
  capacityOrdersPerDay: number
  status: StoreStatus
  codAvailable: boolean
  legalEntityId: string
  managerIds: string[]
  openedOn: string
  imageVariant: number
  hours: StoreHours[]
  holidays: StoreHoliday[]
  pickingBacklog: number
  note?: string // admin vs manager control note shown in UI
}

export interface Zone {
  id: string
  storeId: string
  cityId: string
  name: string
  priority: ZonePriority
  pincodes: string
  polygon: [number, number][] // editable on the Leaflet map
}

// ── §3 Products & pricing ────────────────────────────────────
export interface Product {
  id: string
  name: string
  categoryId: string
  brandId: string
  description: string
  taxRatePct: number
  shelfLifeDays: number
  storage: 'chilled' | 'ambient' | 'frozen'
  imageVariant: number
  publishState: PublishState
  subscribable: boolean
  reorderLevel: number
  pendingApprovalId?: string // sensitive change awaiting approval
  pendingChangeLabel?: string
}

export interface Variant {
  id: string
  productId: string
  label: string
  sku: string
  barcode: string
  price: number
  active: boolean
}

// ── §4 Inventory ─────────────────────────────────────────────
export interface StockLevel {
  storeId: string
  variantId: string
  qty: number
  lowStockThreshold: number
}

export interface StockBatch {
  id: string
  storeId: string
  variantId: string
  qty: number
  expiryDate: string
}

export interface InventoryMovement {
  id: string
  storeId: string
  variantId: string
  type: MovementType
  qtyDelta: number
  reason: string
  actor: string
  at: string
  flagged: boolean
  flagReason?: FlagReason
}

// ── §5 Orders & delivery ─────────────────────────────────────
export interface OrderItem { variantId: string; name: string; qty: number; price: number; total: number }

export interface OrderTimeline {
  placed: string
  confirmed?: string
  picked?: string
  ready?: string
  outForDelivery?: string
  delivered?: string
  cancelled?: string
  held?: string
  released?: string
}

export interface Order {
  id: string
  storeId: string
  customerId: string
  customerName: string
  customerPhone: string
  customerAvatar: number
  amount: number
  deliveryFee: number
  discount: number
  paymentMethod: PaymentMethod
  status: OrderStatus
  placedAt: string
  riderId: string | null
  deliveryCode: string
  deliveryCodeLocked: boolean
  wrongAddressReportedAt?: string
  wrongAddressResolvedAt?: string
  requiresAttention: boolean
  attentionReason?: 'on_hold' | 'wrong_address' | 'code_locked' | 'payment_failed'
  holdReason?: string
  cancelReason?: string
  correctionRequests: Array<{ id: string; kind: string; reason: string; requestedBy: string; status: 'requested' | 'applied' | 'rejected'; at: string }>
  items: OrderItem[]
  timeline: OrderTimeline
}

// ── §6 People ────────────────────────────────────────────────
export interface Customer {
  id: string
  name: string
  phone: string
  email: string
  cityId: string
  avatar: number
  joinedOn: string
  status: 'active' | 'blocked'
  blockedReason?: string
}

export interface RiderDocument { type: 'license' | 'id_proof' | 'bank_details'; status: DocStatus }

export interface Rider {
  id: string
  name: string
  phone: string
  avatar: number
  storeId: string
  status: RiderStatus
  appliedOn: string
  vehicle: string
  documents: RiderDocument[]
  reviewedByStoreManager: boolean // display: "Reviewed by assigned store manager"
  reviewNote?: string
  deliveriesPeriod: number
  rating: number
}

export interface WorkforceAccount {
  id: string
  name: string
  email: string
  phone: string
  role: WorkforceRole
  storeId: string | null
  status: AccountStatus
  lastLogin?: string
  joinedOn: string
  avatar: number
  password: string
  passwordResetRequested?: boolean
  pendingRoleChangeApprovalId?: string
}

// ── §7 Payments, refunds & wallets ───────────────────────────
export interface PaymentAttempt {
  id: string
  orderId: string
  attemptNo: number
  method: Exclude<PaymentMethod, 'cod'>
  amount: number
  status: PaymentAttemptStatus
  gateway: string
  gatewayRef?: string
  failureReason?: string
  at: string
}

export interface Refund {
  id: string
  orderId: string
  amount: number
  status: RefundStatus
  reason: string
  source: RefundSource
  createdAt: string
  paidAt?: string
  evidence?: { reference: string; fileName: string } // manual refund evidence
  canRequestFor?: string // order context when the refund row is a request
}

export interface WalletLedgerEntry {
  id: string
  customerId: string
  customerName: string
  type: WalletEntryType
  amount: number // signed
  balanceAfter: number
  reason: string
  at: string
  authorizedBy?: string // adjustments only
}

export interface ReconciliationFinding {
  id: string
  kind: 'mismatch' | 'unresolved_payment' | 'missing_payout'
  ref: string
  summary: string
  expected: number
  actual: number
  status: FindingStatus
  note?: string
  at: string
}

export interface InvoiceFailure {
  id: string
  invoiceId: string
  orderId: string
  reason: string
  status: 'suspended' | 'rendering'
  causeFixed: boolean // "Retry" only enabled when true
  at: string
}

// ── §8 Rider payouts & COD ───────────────────────────────────
export interface PayoutCorrection {
  id: string
  payoutId: string
  kind: 'correction' | 'cod_offset'
  amount: number // signed
  reason: string
  at: string
}

export interface Payout {
  id: string
  riderId: string
  riderName: string
  storeId: string
  period: string
  deliveriesCount: number
  grossAmount: number
  codCollected: number
  adjustments: number
  netAmount: number
  status: PayoutStatus
  canApprove: boolean // returned by the backend; UI follows it
  approvedAt?: string
  paidAt?: string
  paymentReference?: string
  evidenceFileName?: string
  holdReason?: string
}

// ── §9 Offers & notifications ────────────────────────────────
export interface Coupon {
  id: string
  code: string
  kind: CouponKind
  value: number
  minOrderValue: number
  startsOn: string
  endsOn: string
  usageLimit: number
  usedCount: number
  eligibleStoreIds: string[]
  eligibleProductIds: string[]
  status: CouponStatus
}

export interface PushCampaign {
  id: string
  name: string
  audience: CampaignAudience
  selectedUserIds: string[]
  title: string
  body: string
  status: CampaignStatus
  scheduledAt?: string
  sentAt?: string
  recipients: number
}

export interface AdminNotification {
  id: string
  title: string
  body: string
  kind: 'order' | 'store' | 'payout' | 'approval' | 'support' | 'system'
  at: string
  read: boolean
}

// ── §10 Subscriptions ────────────────────────────────────────
export interface DeliverySlot { id: string; label: string; window: string }
export interface SubscriptionHoliday { date: string; name: string }

export interface SubscriptionRun {
  id: string
  date: string
  generated: number
  status: RunStatus
  failures: Array<{ subscriptionRef: string; customerName: string; reason: string; retryable: boolean }>
}

export interface SubscriptionSettings {
  orderCutoffTime: string
  autoRetryFailed: boolean
  defaultSlotId: string
}

// ── §11 Support & reviews ────────────────────────────────────
export interface TicketMessage { id: string; author: 'customer' | 'admin' | 'system'; body: string; at: string; internal: boolean }
export interface TicketAttachment { id: string; name: string; sizeKb: number; authorized: boolean }
export interface SavedResponse { id: string; title: string; body: string }

export interface Ticket {
  id: string
  ref: string
  subject: string
  category: TicketCategory
  status: TicketStatus
  priority: 'low' | 'normal' | 'high'
  customerId: string | null
  customerName: string
  orderId?: string
  createdAt: string
  updatedAt: string
  messages: TicketMessage[]
  attachments: TicketAttachment[]
}

export interface Rating {
  id: string
  orderId: string
  storeId: string
  customerName: string
  stars: number
  comment: string
  at: string
  moderationRequired: boolean
  moderationStatus: ModerationStatus
  moderationReason?: string
}

// ── §12 Reports & exports ────────────────────────────────────
export type ReportTab = 'catalog_stock' | 'financial' | 'picking' | 'rider_activity' | 'subscriptions' | 'support'

export interface ExportJob {
  id: string
  tab: ReportTab
  label: string
  filtersSummary: string
  status: ExportJobStatus
  rowCount?: number
  fileName?: string
  authorized: boolean
  createdAt: string
  completedAt?: string
  error?: string
}

// ── §13 Approvals & compliance ───────────────────────────────
export interface Approval {
  id: string
  action: string
  targetType: 'variant_price' | 'workforce_role' | 'product_publish' | 'refund_override' | 'coupon_config' | 'business_rule' | 'stock_adjustment'
  targetLabel: string
  details: string
  reason: string
  requesterName: string
  requesterRole: string
  status: ApprovalStatus
  requestedAt: string
  decidedAt?: string
  decidedBy?: string
  canApprove: boolean // returned by the backend; same-admin policy encoded here
  cannotApproveReason?: string
  expiresAt: string
}

export interface FraudFinding {
  id: string
  ref: string
  kind: 'account_takeover' | 'refund_abuse' | 'promo_abuse' | 'cod_shortfall'
  riskLevel: 'low' | 'medium' | 'high'
  summary: string
  status: FraudStatus
  note?: string
  at: string
}

export interface ErasureRequest {
  id: string
  customerId: string
  customerName: string
  requestedAt: string
  status: ErasureStatus
  eligible: boolean // returned by the backend; UI follows it
  ineligibleReason?: string
  note?: string
}

export interface LegalHold {
  id: string
  subjectName: string
  reason: string
  placedAt: string
  releasedAt?: string
  status: 'active' | 'released'
}

// ── §14 Settings & system ────────────────────────────────────
export interface FeatureFlags { cod: boolean; wallets: boolean; subscriptions: boolean }

export interface BusinessRules {
  deliveryFee: number
  freeDeliveryAbove: number
  minOrderValue: number
  maxOrdersPerSlotPerStore: number
  dispatchRadiusKm: number
  dispatchBatchSize: number
  codMaxOrderValue: number
  walletMaxBalance: number
  refundWindowDays: number
  riderRequiredDocs: Array<'license' | 'id_proof' | 'bank_details'>
}

export interface BackgroundJob {
  id: string
  name: string
  kind: 'invoice_render' | 'payout_export' | 'subscription_generate' | 'webhook_delivery' | 'report_email'
  status: JobStatus
  lastRunAt: string
  attempts: number
  error?: string
  recovery: 'retry' | 'requeue' | 'skip'
  canRetry: boolean
  retryAfterFix?: string
}

export interface OperationalNotification {
  id: string
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
  at: string
}

export interface SystemSettings {
  features: FeatureFlags
  rules: BusinessRules
  subscription: SubscriptionSettings
}

// ── Dashboard aggregation (§1) ───────────────────────────────
export interface DashboardSummary {
  range: RangeKey
  storeId: string | 'all'
  ordersPlaced: number
  ordersInProgress: number
  ordersDelivered: number
  ordersCancelled: number
  ordersRequiringAttention: number
  storesOnline: number
  storesPaused: number
  highBacklogStores: Array<{ id: string; name: string; backlog: number }>
  pendingRiderApplications: number
  pendingRefunds: number
  pendingApprovals: number
  openTickets: number
  lowStock: Array<{ storeName: string; variantName: string; qty: number; threshold: number }>
  expiringStock: Array<{ storeName: string; variantName: string; qty: number; expiryDate: string }>
  reconciliationIssues: number
  failedJobs: number
  sales: number // separate KPI
  walletTopUps: number // separate KPI
  refunds: number // separate KPI — never combined
}

// ── Root dataset (single source of truth) ─────────────────────
export interface DBMeta {
  salesCaptured: number
  walletTopUpsTotal: number
  paidRefundsTotal: number
  walletBalances: Record<string, number>
}

export interface DB {
  demoNow: string
  cities: City[]
  legalEntities: LegalEntity[]
  stores: Store[]
  zones: Zone[]
  workforce: WorkforceAccount[]
  products: Product[]
  variants: Variant[]
  categories: ProductCategory[]
  brands: Brand[]
  storeVariants: VariantAvailability[]
  stockLevels: StockLevel[]
  stockBatches: StockBatch[]
  movements: InventoryMovement[]
  customers: Customer[]
  riders: Rider[]
  orders: Order[]
  paymentAttempts: PaymentAttempt[]
  refunds: Refund[]
  walletLedger: WalletLedgerEntry[]
  reconciliationFindings: ReconciliationFinding[]
  invoiceFailures: InvoiceFailure[]
  payouts: Payout[]
  payoutCorrections: PayoutCorrection[]
  coupons: Coupon[]
  pushCampaigns: PushCampaign[]
  adminNotifications: AdminNotification[]
  deliverySlots: DeliverySlot[]
  subscriptionHolidays: SubscriptionHoliday[]
  subscriptionRuns: SubscriptionRun[]
  savedResponses: SavedResponse[]
  tickets: Ticket[]
  ratings: Rating[]
  approvals: Approval[]
  fraudFindings: FraudFinding[]
  erasureRequests: ErasureRequest[]
  legalHolds: LegalHold[]
  exportJobs: ExportJob[]
  backgroundJobs: BackgroundJob[]
  operationalNotifications: OperationalNotification[]
  systemSettings: SystemSettings
  meta: DBMeta
  // ── Store manager portal ──
  storeManagers: StoreManagerAssignment[]
  binLocations: Array<{ storeId: string; bins: string[] }>
  pickingTasks: PickingTask[]
  returns: ReturnParcel[]
  riderApplications: RiderApplication[]
  codDeposits: CodDeposit[]
  inventoryBatches: InventoryBatch[]
  stockReceipts: StockReceipt[]
  stockCounts: StockCount[]
  stockAdjustments: StockAdjustment[]
  storeStatusChanges: StoreStatusChange[]
  storeNotifications: StoreNotification[]
  storeNotificationPrefs: Array<{ workforceId: string; prefs: StoreNotificationPrefs }>
}

// ── Shared utility types (charts, product glyphs) ────────────
export type ProductIcon = 'milk' | 'paneer' | 'ghee' | 'curd' | 'butter' | 'lassi' | 'buttermilk' | 'cream' | 'cheese' | 'khoya' | 'flavored_milk'

export interface StatusSlice {
  key: string
  label: string
  value: number
  color: string
}


// ── Store manager portal domain ─────────────────────────────────
export interface StoreManagerAssignment { id: string; workforceId: string; storeId: string }

export type PickingTaskStatus = 'waiting_to_pick' | 'being_picked' | 'ready_to_pack' | 'ready_for_handover' | 'completed' | 'cancelled'
export interface SubstituteCandidate {
  variantId: string
  name: string
  sku: string
  barcode: string | null
  available: number
}
export interface PickLine {
  id: string
  variantId: string
  name: string
  icon: ProductIcon
  sku: string
  barcode: string | null
  qtyOrdered: number
  qtyPicked: number
  batchId: string
  batchCode: string
  batchExpiry: string
  substitutionVariantId?: string
  unavailableReason?: string
  resolved: boolean
  substitutionCandidates: SubstituteCandidate[]
}
export interface PackingDetails { bags: number; coldChain: boolean; packedBy: string; sealCode?: string; packedAt?: string; notes?: string }
export interface HandoverDetails {
  state: 'PENDING' | 'VERIFIED' | 'OVERRIDE'
  riderId: string | null
  riderName: string | null
  attempts: number
  locked: boolean
  verifiedAt?: string
  deliveryStatus: string | null
}
export interface PickingTask {
  id: string
  orderId: string
  orderNumber?: string | null
  orderStatus?: string
  customerName?: string
  storeId: string
  status: PickingTaskStatus
  assigneeId: string | null
  assigneeName?: string | null
  claimedAt?: string
  deadline: string
  createdAt: string
  lines: PickLine[]
  packing?: PackingDetails
  handover?: HandoverDetails
  deliveryStatus?: string | null
  completedAt?: string
}

export type ReturnReason = 'customer_unavailable' | 'wrong_address' | 'delivery_refused' | 'rider_could_not_deliver' | 'other'
export type ReturnStatus = 'pending' | 'under_inspection' | 'processed'
export type QualityDecision = 'saleable' | 'damaged' | 'expired'
export interface ReturnItemLine { variantId: string; name: string; icon: ProductIcon; qty: number; batchId: string; decision?: QualityDecision; returnId?: string; returnStatus?: 'QUARANTINED' | 'APPROVED' | 'REJECTED'; expiresAt?: string | null }
export interface ReturnParcel {
  id: string
  orderId: string
  orderNumber?: string
  customerName?: string
  storeId: string
  returnedAt: string
  reason: ReturnReason
  status: ReturnStatus
  items: ReturnItemLine[]
  stockAction?: 'quarantine' | 'write_off'
  note?: string
  draft: boolean
  processedAt?: string
}

export type RiderAppStatus = 'pending' | 'under_review' | 'approved' | 'rejected'
export type RiderDocType = 'license' | 'vehicle_rc' | 'aadhaar' | 'insurance'
export type RiderDocStatus = 'pending' | 'approved' | 'rejected'
export interface RiderApplicationDoc { type: RiderDocType; label: string; number: string; status: RiderDocStatus; decidedAt?: string; reason?: string }
export interface RiderApplication {
  id: string
  storeId: string
  riderName: string
  phone: string
  email: string
  vehicle: { type: string; makeModel: string; registration: string; color: string; year: number }
  appliedAt: string
  status: RiderAppStatus
  documents: RiderApplicationDoc[]
}

export type DepositOutcome = 'received' | 'pending_verification' | 'discrepancy'
export interface CodDeposit {
  id: string
  storeId: string
  riderId: string
  riderName: string
  amount: number
  reference: string
  outcome: DepositOutcome
  remarks?: string
  at: string
}

export interface InventoryBatch { id: string; storeId: string; variantId: string; qty: number; expiryDate: string; binLocation: string }
export interface StockReceipt { id: string; storeId: string; variantId: string; batchNo: string; expiryDate: string; qty: number; binLocation: string; at: string; by: string }
export interface StockCountLine {
  id: string
  batchId: string
  batchCode: string
  variantId: string
  name: string
  expected: number
  counted: number | null
  reason: string | null
  outcome?: 'APPLIED' | 'PENDING_APPROVAL' | 'FAILED' | null
  outcomeDetail?: string | null
}
export interface StockCount {
  id: string
  storeId: string
  startedAt: string
  completedAt?: string
  status: 'open' | 'completed' | 'cancelled'
  note?: string
  version: string
  lines: StockCountLine[]
}
export type AdjustmentApprovalStatus = 'pending' | 'approved' | 'rejected'
export interface StockAdjustment { id: string; storeId: string; variantId: string; delta: number; reason: string; by: string; at: string; approvalStatus: AdjustmentApprovalStatus; approvalId?: string }

export interface StoreStatusChange { id: string; storeId: string; status: 'online' | 'paused'; by: string; role: string; at: string; reason?: string }

export type StoreNotificationKind = 'action' | 'operational' | 'system'
export interface StoreNotification {
  id: string
  storeId: string | null
  title: string
  body: string
  kind: StoreNotificationKind
  requiresAction: boolean
  read: boolean
  at: string
  link?: string
}
export interface StoreNotificationPrefs {
  pickingOrders: boolean
  inventoryAlerts: boolean
  riderApplications: boolean
  codDeposits: boolean
  storeStatus: boolean
}
