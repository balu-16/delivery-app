/**
 * Store-manager stock-count sessions. The manager records counted quantities
 * across several visits, then completes the session; completion delegates each
 * counted line to the cycle-count engine so approval thresholds and the stock
 * ledger keep their existing rules.
 */
export interface CountSessionLineInput {
  batchId: string;
  /** Absolute counted on-hand; null clears a previously entered value. */
  counted: string | null;
  reason?: string | null;
}

export interface CountSessionCreateInput {
  storeId: string;
  note?: string | null;
  /** Omit to snapshot every active batch currently on hand. */
  lines?: CountSessionLineInput[];
}

export interface CountSessionUpdateInput {
  note?: string | null;
  lines?: CountSessionLineInput[];
  /** Optimistic concurrency for concurrent tabs. */
  expectedVersion?: string;
}

export interface CountSessionLineView {
  lineNo: number;
  variantId: string;
  variantName: string;
  sku: string;
  batchId: string;
  batchCode: string;
  expiresAt: string | null;
  expectedQty: string;
  countedQty: string | null;
  reason: string | null;
  outcome: 'APPLIED' | 'PENDING_APPROVAL' | 'FAILED' | null;
  outcomeDetail: string | null;
}

export interface CountSessionView {
  id: string;
  storeId: string;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  note: string | null;
  version: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lines: CountSessionLineView[];
}

export interface CountSessionPage {
  items: CountSessionView[];
  nextCursor: string | null;
}

export const INVENTORY_COUNT_SESSIONS = Symbol('INVENTORY_COUNT_SESSIONS');

export interface InventoryCountSessions {
  create(actorId: string, input: CountSessionCreateInput): Promise<CountSessionView>;
  get(actorId: string, sessionId: string): Promise<CountSessionView>;
  list(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<CountSessionPage>;
  update(
    actorId: string,
    sessionId: string,
    input: CountSessionUpdateInput,
  ): Promise<CountSessionView>;
  /** Applies every counted line, records per-line outcomes and closes the session. */
  complete(actorId: string, sessionId: string, reference: string): Promise<CountSessionView>;
  cancel(actorId: string, sessionId: string): Promise<CountSessionView>;
}
