/**
 * Admin portal read contracts (P14). One bounded domain module backing the
 * DairyDirect admin web portal's aggregate, fleet, dispatch, finance,
 * inventory, ratings, privacy and global-search reads. All queries are
 * keyset-paginated or hard-bounded; money is integer paise serialized as
 * decimal strings. Cross-module callers import only this file.
 */

export interface DashboardQuery {
  /** ISO calendar dates interpreted in Asia/Kolkata (business-day bounds). */
  readonly from: string;
  readonly to: string;
  readonly storeId?: string;
}

export interface AdminOrderStatusCounts {
  readonly placed: number;
  readonly confirmed: number;
  readonly picking: number;
  readonly packed: number;
  readonly outForDelivery: number;
  readonly delivered: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly onHold: number;
}

export interface AdminDashboardView {
  readonly period: { readonly from: string; readonly to: string };
  /** Issued INVOICE totals minus issued CREDIT_NOTE totals inside the window. */
  readonly invoicedSalesPaise: string | null;
  readonly creditNotesPaise: string | null;
  readonly refundsProcessedPaise: string | null;
  readonly walletTopUpsPaise: { readonly total: string | null };
  readonly orders: AdminOrderStatusCounts;
  /** Current snapshot counts, not window activity. */
  readonly stores: { readonly total: number; readonly online: number };
  readonly customers: { readonly total: number; readonly active: number };
}

export type FleetAvailability = 'AVAILABLE' | 'ON_DELIVERY' | 'OFFLINE' | 'UNKNOWN';

export interface FleetRiderView {
  readonly riderId: string;
  readonly name: string;
  readonly storeId: string | null;
  readonly availability: FleetAvailability;
  readonly lastLocation: { readonly lat: number; readonly lng: number } | null;
  readonly lastUpdateAt: string | null;
  readonly fresh: boolean;
}

export interface FleetView {
  readonly items: readonly FleetRiderView[];
  readonly freshnessSeconds: number;
}

export interface RiderCandidateView {
  readonly riderId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface InvoiceDownloadView {
  readonly url: string;
  readonly expiresIn: number;
  readonly documentId: string;
  readonly number: string;
}

export interface PaymentAttemptListItem {
  readonly attemptId: string;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly storeId: string | null;
  readonly storeName: string | null;
  readonly kind: 'ORDER_PAYMENT' | 'WALLET_TOPUP';
  readonly gateway: string;
  readonly gatewayPaymentId: string | null;
  readonly amountPaise: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly paymentMethod: string | null;
  readonly createdAt: string;
}

export interface RefundListItem {
  readonly refundId: string;
  readonly orderId: string;
  readonly orderNumber: string | null;
  readonly storeId: string | null;
  readonly storeName: string | null;
  readonly amountPaise: string;
  readonly destination: string;
  readonly status: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface InventorySummaryItem {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  readonly units: string;
  readonly availableStores: number;
  readonly lowStockStores: number;
  readonly totalReserved: string;
}

export interface RatingListItem {
  readonly ratingId: string;
  readonly orderId: string;
  readonly orderNumber: string | null;
  readonly raterUserId: string;
  readonly raterName: string | null;
  readonly targetType: string;
  readonly targetId: string;
  readonly stars: number;
  readonly comment: string | null;
  readonly hidden: boolean;
  readonly createdAt: string;
}

export interface LegalHoldListItem {
  readonly holdId: string;
  readonly userId: string;
  readonly userEmail: string | null;
  readonly userName: string | null;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly releasedAt: string | null;
}

export type GlobalSearchGroup =
  'Stores' | 'Products' | 'Orders' | 'Customers' | 'Riders' | 'Tickets';

export interface GlobalSearchItem {
  readonly id: string;
  readonly title: string;
  readonly sub: string | null;
}

export interface GlobalSearchView {
  readonly groups: ReadonlyArray<{
    readonly group: GlobalSearchGroup;
    readonly items: readonly GlobalSearchItem[];
  }>;
}

export interface PaymentAttemptFilter {
  readonly storeId?: string;
  readonly status?: string;
  readonly method?: string;
  readonly from?: string;
  readonly to?: string;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RefundFilter {
  readonly storeId?: string;
  readonly status?: string;
  readonly search?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface InventorySummaryFilter {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RatingsFilter {
  readonly queueOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface GlobalSearchQuery {
  readonly q: string;
}

/**
 * Data access stays inside this module (surfaces never touch the platform
 * database directly); dispatch eligibility and location freshness reuse the
 * ports published by the riders/tracking modules.
 */
export const ADMIN_PORTAL_READS = Symbol('ADMIN_PORTAL_READS');
export interface AdminPortalReads {
  dashboard(query: DashboardQuery): Promise<AdminDashboardView>;
  fleet(): Promise<FleetView>;
  riderCandidates(orderId: string): Promise<readonly RiderCandidateView[]>;
  orderInvoice(orderId: string): Promise<InvoiceDownloadView>;
  paymentAttempts(filter: PaymentAttemptFilter): Promise<Page<PaymentAttemptListItem>>;
  refunds(filter: RefundFilter): Promise<Page<RefundListItem>>;
  inventorySummary(filter: InventorySummaryFilter): Promise<Page<InventorySummaryItem>>;
  ratings(filter: RatingsFilter): Promise<Page<RatingListItem>>;
  legalHolds(cursor: string | undefined, limit: number): Promise<Page<LegalHoldListItem>>;
  search(query: GlobalSearchQuery): Promise<GlobalSearchView>;
}

/** Exported for reuse by the surface's cursor decoding and tests. */
export function decodeKeysetCursor<T>(
  cursor: string | undefined,
  parse: (raw: unknown) => T,
): T | null {
  if (!cursor) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('INVALID_CURSOR');
  }
  try {
    return parse(decoded);
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}

export function encodeKeysetCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
