import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useAuth } from '@/store/auth'
import type {
  InventorySummaryRow, LedgerRow, OrderStatus, RangeKey, StockRow,
} from '@/types'
import * as apiStores from '@/api/stores'
import * as apiCatalog from '@/api/catalog'
import * as apiInventory from '@/api/inventory'
import * as apiOrders from '@/api/orders'
import * as apiPeople from '@/api/people'
import * as apiPayments from '@/api/payments'
import * as apiPayouts from '@/api/payouts'
import * as apiOffers from '@/api/offers'
import * as apiSubs from '@/api/subscriptions'
import * as apiSupport from '@/api/support'
import * as apiReports from '@/api/reports'
import type { ReportKind } from '@/types'
import * as apiApprovals from '@/api/approvals'
import * as apiSettings from '@/api/settings'
import * as apiDashboard from '@/api/dashboard'

/**
 * React Query hooks for the real backend. Every key includes the signed-in
 * admin id so the cache is scoped per session; mutations invalidate targeted
 * keys (see mutations.ts). Cursor lists return {items, nextCursor} — there are
 * NO fabricated totals; pages render "hasMore" semantics instead.
 */

/** Admin id from the auth store — included in every query key. */
export function useScope(): string {
  return useAuth((s) => s.admin?.id ?? 'anon')
}

const V = { staleTime: 15_000, gcTime: 5 * 60_000, placeholderData: keepPreviousData }

// ── §1 Dashboard ─────────────────────────────────────────────────────────────
export const useDashboard = (range: RangeKey, storeId: string | 'all') => {
  const scope = useScope()
  return useQuery({ queryKey: ['dashboard', scope, range, storeId], queryFn: () => apiDashboard.getDashboard(range, storeId), ...V })
}

// ── §2 Stores & service areas ────────────────────────────────────────────────
export const useStores = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['stores', scope], queryFn: () => apiStores.listStores(100).then((p) => p.items), ...V })
}
export const useStoreOperations = (id: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['store-operations', scope, id], queryFn: () => apiStores.getStoreOperations(id!), enabled: !!id, ...V })
}
export const useZones = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['zones', scope], queryFn: () => apiStores.listZones(100).then((p) => p.items), ...V })
}
export const useCities = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['cities', scope], queryFn: () => apiStores.listCities(100).then((p) => p.items), ...V })
}
export const useLegalEntities = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['legal-entities', scope], queryFn: () => apiStores.listLegalEntities(100).then((p) => p.items), ...V })
}

// ── §3 Products & pricing ────────────────────────────────────────────────────
export const useProducts = (limit = 50, cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['products', scope, limit, cursor ?? null], queryFn: () => apiCatalog.listProducts(limit, cursor), ...V })
}
export const useVariants = (limit = 100, productId?: string, enabled = true) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['variants', scope, limit, productId ?? null],
    queryFn: () => apiCatalog.listVariants(limit, undefined, productId).then((p) => p.items),
    enabled,
    ...V,
  })
}
export const useCategories = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['categories', scope], queryFn: () => apiCatalog.listCategories(100).then((p) => p.items), ...V })
}
export const useBrands = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['brands', scope], queryFn: () => apiCatalog.listBrands(100).then((p) => p.items), ...V })
}

// ── §4 Inventory ─────────────────────────────────────────────────────────────
/**
 * Full-catalog summary feed (≤200 rows per backend page, cursor followed up to
 * five rounds). Every variant name/sku resolves here — the per-store report and
 * ledger join against this feed, so UUID fallbacks never appear.
 */
export const useInventorySummary = (search?: string) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['inventory-summary', scope, search ?? null],
    queryFn: async () => {
      const items: InventorySummaryRow[] = []
      let cursor: string | undefined
      for (let round = 0; round < 5; round++) {
        const page = await apiInventory.inventorySummary({ search, cursor, limit: 200 })
        items.push(...page.items)
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      return { items, nextCursor: null as string | null }
    },
    ...V,
  })
}
export const useInventoryReport = (storeId: string | null, cursor?: string) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['inventory-report', scope, storeId, cursor ?? null],
    queryFn: () => apiInventory.inventoryReport(storeId!, 100, cursor),
    enabled: !!storeId,
    ...V,
  })
}
export const useInventoryLedger = (storeId: string | null, variantId?: string, cursor?: string) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['inventory-ledger', scope, storeId, variantId ?? null, cursor ?? null],
    queryFn: () => apiInventory.inventoryLedger(storeId!, { variantId, cursor }),
    enabled: !!storeId,
    ...V,
  })
}
export const useShelfLife = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['shelf-life', scope], queryFn: () => apiInventory.shelfLifeList(100).then((p) => p.items), ...V })
}

// ── §5 Orders & delivery ─────────────────────────────────────────────────────
export interface OrderListArgs {
  storeId?: string
  userId?: string
  status?: OrderStatus
  placedAfter?: string
  limit?: number
  cursor?: string
}
export const useOrders = (filters: OrderListArgs) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['orders', scope, filters.storeId ?? null, filters.userId ?? null, filters.status ?? null, filters.placedAfter ?? null, filters.limit ?? null, filters.cursor ?? null],
    queryFn: () => apiOrders.listOrders(filters),
    ...V,
  })
}
export const useOrderDetail = (id: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['order-detail', scope, id], queryFn: () => apiOrders.getOrderDetail(id!), enabled: !!id, ...V })
}
export const useOrderTimeline = (id: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['order-timeline', scope, id], queryFn: () => apiOrders.getOrderTimeline(id!), enabled: !!id, ...V })
}
export const useOrderPayments = (id: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['order-payments', scope, id], queryFn: () => apiOrders.getOrderPayments(id!), enabled: !!id, ...V })
}
export const useRiderCandidates = (orderId: string | null, enabled = true) => {
  const scope = useScope()
  return useQuery({ queryKey: ['rider-candidates', scope, orderId], queryFn: () => apiOrders.riderCandidates(orderId!), enabled: !!orderId && enabled, staleTime: 0, gcTime: 0 })
}
export const useFleet = (enabled = true) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['fleet', scope],
    queryFn: () => apiOrders.getFleet(),
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  })
}

// ── §6 People ────────────────────────────────────────────────────────────────
export interface UserListArgs { search?: string; cursor?: string; limit?: number }
export const useUsers = (filters: UserListArgs) => {
  const scope = useScope()
  return useQuery({ queryKey: ['users', scope, filters.search ?? null, filters.cursor ?? null, filters.limit ?? null], queryFn: () => apiPeople.listUsers(filters), ...V })
}
export const useWorkforce = (filters: UserListArgs) => {
  const scope = useScope()
  return useQuery({ queryKey: ['workforce', scope, filters.search ?? null, filters.cursor ?? null, filters.limit ?? null], queryFn: () => apiPeople.listWorkforce(filters), ...V })
}
export const useRiderApplications = (opts?: { status?: string; cursor?: string }) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['rider-applications', scope, opts?.status ?? null, opts?.cursor ?? null],
    queryFn: () => apiPeople.listRiderApplications({ status: opts?.status as never, cursor: opts?.cursor }),
    ...V,
  })
}
export const useRiderApplication = (userId: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['rider-application', scope, userId], queryFn: () => apiPeople.getRiderApplication(userId!), enabled: !!userId, ...V })
}

// ── §7 Payments, refunds & wallets ───────────────────────────────────────────
export interface PaymentListArgs {
  storeId?: string; status?: string; method?: string; from?: string; to?: string
  search?: string; cursor?: string; limit?: number
}
export const usePaymentAttempts = (filters: PaymentListArgs) => {
  const scope = useScope()
  return useQuery({ queryKey: ['payment-attempts', scope, filters], queryFn: () => apiPayments.listPaymentAttempts(filters), ...V })
}
export const useRefundList = (filters: PaymentListArgs) => {
  const scope = useScope()
  return useQuery({ queryKey: ['refunds', scope, filters], queryFn: () => apiPayments.listRefunds(filters), ...V })
}
export interface WalletArgs { userId?: string; bucket?: 'cash' | 'promo'; reason?: string; cursor?: string; limit?: number }
export const useWalletLedger = (filters: WalletArgs) => {
  const scope = useScope()
  return useQuery({ queryKey: ['wallet-ledger', scope, filters], queryFn: () => apiPayments.walletLedger(filters), ...V })
}
export const useReconciliation = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['reconciliation', scope, cursor ?? null], queryFn: () => apiPayments.listReconciliation(50, cursor), ...V })
}
export const useInvoiceFailures = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['invoice-failures', scope, cursor ?? null], queryFn: () => apiPayments.listInvoiceFailures(50, cursor), ...V })
}

// ── §8 Payouts ───────────────────────────────────────────────────────────────
export const usePayouts = (opts?: { cursor?: string; riderNames?: Record<string, string> }) => {
  const scope = useScope()
  return useQuery({ queryKey: ['payouts', scope, opts?.cursor ?? null, opts?.riderNames ?? null], queryFn: () => apiPayouts.listPayouts(opts), ...V })
}
export const usePayoutCorrections = (payoutId: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['payout-corrections', scope, payoutId], queryFn: () => apiPayouts.listPayoutCorrections(payoutId!), enabled: !!payoutId, ...V })
}

// ── §9 Offers & notifications ────────────────────────────────────────────────
export const useCoupons = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['coupons', scope, cursor ?? null], queryFn: () => apiOffers.listCoupons(50, cursor), ...V })
}
export const useCampaigns = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['campaigns', scope, cursor ?? null], queryFn: () => apiOffers.listCampaigns(cursor), ...V })
}
export const useInbox = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['inbox', scope, cursor ?? null], queryFn: () => apiOffers.listInbox(cursor, 30), ...V })
}
export const useUnreadCount = (enabled = true) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['unread-count', scope],
    queryFn: () => apiOffers.unreadCount().then((r) => r.count),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  })
}

// ── §10 Subscriptions ────────────────────────────────────────────────────────
export const useSubscriptionPlans = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['sub-plans', scope], queryFn: () => apiSubs.subscriptionPlans(100).then((p) => p.items), ...V })
}
export const useSubscriptionSlots = (storeId: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['sub-slots', scope, storeId], queryFn: () => apiSubs.subscriptionSlots(storeId!), enabled: !!storeId, ...V })
}
export const useSubscriptionHolidays = (storeId: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['sub-holidays', scope, storeId], queryFn: () => apiSubs.subscriptionHolidays(storeId!), enabled: !!storeId, ...V })
}
export const useSubscriptionRuns = (storeId?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['sub-runs', scope, storeId ?? null], queryFn: () => apiSubs.subscriptionRuns({ storeId, limit: 50 }), ...V })
}

// ── §11 Support & reviews ────────────────────────────────────────────────────
export const useTickets = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['tickets', scope, cursor ?? null], queryFn: () => apiSupport.listTickets(cursor, 50), ...V })
}
export const useTicket = (id: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['ticket', scope, id], queryFn: () => apiSupport.getTicket(id!), enabled: !!id, ...V })
}
export const useSavedResponses = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['saved-responses', scope], queryFn: () => apiSupport.listCannedResponses(undefined, 50).then((p) => p.items), ...V })
}
export const useRatings = (queueOnly = false, cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['ratings', scope, queueOnly, cursor ?? null], queryFn: () => apiSupport.listRatings(queueOnly, cursor), ...V })
}

// ── §12 Reports & exports ────────────────────────────────────────────────────
export const useReportPreview = (
  kind: ReportKind,
  filters?: { storeId?: string; from?: string; to?: string; cursor?: string; limit?: number },
) => {
  const scope = useScope()
  return useQuery({
    queryKey: ['report-preview', scope, kind, filters?.storeId ?? null, filters?.from ?? null, filters?.to ?? null, filters?.cursor ?? null, filters?.limit ?? null],
    queryFn: () => apiReports.reportPreview(kind, filters),
    ...V,
  })
}
export const useExportJobs = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['export-jobs', scope], queryFn: () => apiReports.listReportExports(undefined, 50).then((p) => p.items), ...V })
}

// ── §13 Approvals & compliance ───────────────────────────────────────────────
export const useApprovals = (cursor?: string) => {
  const scope = useScope()
  return useQuery({ queryKey: ['approvals', scope, cursor ?? null], queryFn: () => apiApprovals.listApprovals(cursor, 50), ...V })
}
export const useFraudSignals = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['fraud-signals', scope], queryFn: () => apiApprovals.listFraudSignals(undefined, 50).then((p) => p.items), ...V })
}
export const useErasureRequests = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['erasure-requests', scope], queryFn: () => apiApprovals.listErasureRequests(undefined, 50).then((p) => p.items), ...V })
}
export const useLegalHolds = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['legal-holds', scope], queryFn: () => apiApprovals.listLegalHolds(undefined, 50).then((p) => p.items), ...V })
}

// ── §14 Settings & system ────────────────────────────────────────────────────
export const useConfig = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['config', scope], queryFn: () => apiSettings.getConfig(), ...V })
}
export const useFailedJobs = (concern: string | null) => {
  const scope = useScope()
  return useQuery({ queryKey: ['failed-jobs', scope, concern], queryFn: () => apiApprovals.listFailedJobs(concern!), enabled: !!concern, ...V })
}
export const useOutboxStatus = () => {
  const scope = useScope()
  return useQuery({ queryKey: ['outbox', scope], queryFn: () => apiApprovals.outboxStatus(), ...V })
}

// ── Store options helper (filters/selects) ───────────────────────────────────
export const useStoreOptions = () => {
  const storesQ = useStores()
  return storesQ
}

// Re-exported value types for pages
export type { InventorySummaryRow, LedgerRow, OrderStatus, StockRow }
