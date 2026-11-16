/**
 * Store-manager portal reads that span several aggregates (orders, catalog,
 * returns, inspection drafts). Every call re-checks the caller's STORE_MANAGER
 * assignment for the requested store before touching data, mirroring the
 * per-request store scoping the rest of the /v1/store surface uses.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type StoreSearchType = 'ORDERS' | 'CUSTOMERS' | 'PRODUCTS';

export interface StoreOrderSearchItem {
  orderId: string;
  orderNumber: string;
  status: string;
  customerName: string;
  totalPaise: string;
  placedAt: string;
  itemCount: number;
}

export interface StoreCustomerSearchItem {
  userId: string;
  name: string;
  email: string | null;
  orderCount: number;
  lastOrderAt: string | null;
}

export interface StoreProductSearchItem {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  available: string | null;
}

export type StoreSearchItem =
  StoreOrderSearchItem | StoreCustomerSearchItem | StoreProductSearchItem;

export interface EligibleReturnOrder {
  orderId: string;
  orderNumber: string;
  customerName: string;
  failureReason: string | null;
  failedAt: string | null;
  itemCount: number;
  totalPaise: string;
}

export interface RecordedReturn {
  returnId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  failureReason: string | null;
  variantId: string;
  variantName: string;
  quantity: string;
  status: 'QUARANTINED' | 'APPROVED' | 'REJECTED';
  reason: string | null;
  createdAt: string;
  inspectedAt: string | null;
}

export interface ReturnOrderDetail {
  orderId: string;
  orderNumber: string;
  customerName: string;
  status: string;
  failureReason: string | null;
  failedAt: string | null;
  totalPaise: string;
  items: {
    variantId: string;
    variantName: string;
    quantity: string;
    expiresAt: string | null;
  }[];
  returns: {
    returnId: string;
    variantId: string;
    variantName: string;
    quantity: string;
    status: 'QUARANTINED' | 'APPROVED' | 'REJECTED';
    reason: string | null;
    createdAt: string;
    inspectedAt: string | null;
  }[];
}

export type InspectionDecision = 'SALEABLE' | 'DAMAGED' | 'EXPIRED';

export interface InspectionDraftItem {
  variantId: string;
  quantity: string;
  decision: InspectionDecision;
  note: string | null;
}

export interface InspectionDraft {
  orderId: string;
  items: InspectionDraftItem[];
  note: string | null;
  version: number;
  updatedAt: string;
}

export const STORE_PORTAL_READS = Symbol('STORE_PORTAL_READS');

export interface StorePortalReads {
  /** Authorized search over the store's orders, customers and products. */
  search(
    actorId: string,
    storeId: string,
    type: StoreSearchType,
    query: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<StoreSearchItem>>;
  /** Failed-delivery orders at the store that have not been recorded yet. */
  eligibleReturnOrders(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<EligibleReturnOrder>>;
  /** Recorded return parcels (quarantine + QC outcomes) for the store. */
  recordedReturns(
    actorId: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<RecordedReturn>>;
  /** Full return picture for one failed-delivery order. */
  returnDetail(actorId: string, storeId: string, orderId: string): Promise<ReturnOrderDetail>;
  /** Upserts the manager's persistent per-item inspection draft. */
  saveInspectionDraft(
    actorId: string,
    storeId: string,
    orderId: string,
    items: InspectionDraftItem[],
    note: string | null,
  ): Promise<InspectionDraft>;
  getInspectionDraft(
    actorId: string,
    storeId: string,
    orderId: string,
  ): Promise<InspectionDraft | null>;
}
