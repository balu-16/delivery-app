import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Public rider-operations contracts. Approval/kyc stays in P1
 * (rider_profiles); this module owns operational state (online/shifts/
 * heartbeat/capacity), the cash-in-hand ledger, COD collection records and
 * exactly-once earnings (P8). Dispatch consumes the read/eligibility ports.
 */

export type ShiftEndReason = 'RIDER' | 'AUTO_INACTIVITY' | 'MAX_HOURS' | 'SUSPENSION' | 'SYSTEM';
export type EligibilityRejection =
  | 'ON_BREAK'
  | 'NOT_APPROVED'
  | 'SUSPENDED'
  | 'OFFLINE'
  | 'STALE_LOCATION'
  | 'AT_TASK_CAPACITY'
  | 'CASH_LIMIT';

export interface RiderStatusView {
  riderId: string;
  online: boolean;
  onBreak: boolean;
  lastHeartbeatAt: string | null;
  lastLocationAt: string | null;
  activeTasks: number;
  idleSince: string | null;
  unreachableSince: string | null;
}

export interface ShiftView {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: ShiftEndReason | null;
}

export interface RiderMeView {
  riderId: string;
  /** P1 rider_profiles.status (PENDING/UNDER_REVIEW/APPROVED/REJECTED/SUSPENDED). */
  profileStatus: string;
  status: RiderStatusView;
  currentShift: ShiftView | null;
}

export interface HeartbeatInput {
  /** Optional freshness hint; authoritative position still flows via /location. */
  lat?: number;
  lng?: number;
}

export const RIDER_OPERATIONS = Symbol('RIDER_OPERATIONS');
export interface RiderOperations {
  setBreak(riderId: string, onBreak: boolean): Promise<RiderStatusView>;
  /** Requires an APPROVED profile; opens a shift and marks the rider online. */
  goOnline(riderId: string, reference: string): Promise<RiderStatusView>;
  /** Closes the open shift; active tasks keep custody and are swept by dispatch. */
  goOffline(riderId: string, reference: string): Promise<RiderStatusView>;
  heartbeat(riderId: string, input: HeartbeatInput, at?: Date): Promise<RiderStatusView>;
  me(riderId: string): Promise<RiderMeView>;
}

export interface CashEntryView {
  id: string;
  deltaPaise: string;
  reason: 'COD_COLLECTED' | 'COD_DEPOSIT' | 'ADJUSTMENT';
  refType: string;
  refId: string;
  balanceAfter: string;
  createdAt: string;
}
export interface CashPage {
  items: CashEntryView[];
  nextCursor: string | null;
}
export interface CashInHandView {
  cashInHandPaise: string;
  /** null when the limit cannot be displayed; dispatch eligibility requires configured limits. */
  limitPaise: string | null;
}

export const RIDER_CASH = Symbol('RIDER_CASH');
export interface RiderCash {
  cashInHand(riderId: string): Promise<CashInHandView>;
  ledger(riderId: string, cursor?: string, limit?: number): Promise<CashPage>;
  /**
   * Store-manager/ops recorded deposit; discrepancy versus the outstanding
   * balance is computed and flagged through the store COD deposit endpoint.
   */
  recordDeposit(input: {
    riderId: string;
    amountPaise: string;
    depositReference: string;
    storeId?: string;
    actorId: string;
  }): Promise<{ id: string; discrepancyPaise: string }>;
}

export interface CodCollectInput {
  orderId: string;
  riderId: string;
  /** The amount the rider physically collected; a mismatch is flagged, not refused. */
  amountPaise: string;
}
export interface CodCollectResult {
  state: 'COLLECTED';
  mismatch: boolean;
  expectedPaise: string | null;
}

/**
 * COD collection records (007 cod_collections) are owned here; the dispatch
 * deliver flow calls this before completing a COD order (PAY-09: a mismatch
 * blocks automatic successful completion).
 */
export const COD_COLLECTIONS = Symbol('COD_COLLECTIONS');
export interface CodCollections {
  collect(input: CodCollectInput, tx?: TransactionContext): Promise<CodCollectResult>;
}

export interface EarningView {
  taskId: string;
  orderId: string;
  basePaise: string;
  distancePaise: string;
  detentionPaise: string;
  incentivePaise: string;
  tipPaise: string;
  adjustmentPaise: string;
  totalPaise: string;
  distanceMetres: number;
  detentionMinutes: number;
  computedAt: string;
}
export interface EarningPage {
  items: EarningView[];
  nextCursor: string | null;
}
export interface EarningTaskInput {
  taskId: string;
  orderId: string;
  riderId: string;
  distanceMetres: number;
  /** Wait minutes at the store (arrived-at-store to picked-up). */
  detentionMinutes: number;
  tipPaise: string;
}

export const RIDER_EARNINGS = Symbol('RIDER_EARNINGS');
export interface RiderEarnings {
  /** Exactly once per task (UNIQUE(task_id)); replay returns the stored row. */
  recordForTask(input: EarningTaskInput, tx?: TransactionContext): Promise<EarningView>;
  forRider(riderId: string, cursor?: string, limit?: number): Promise<EarningPage>;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: EligibilityRejection;
}

/**
 * Dispatch revalidates every GEO candidate through this port under rider
 * status locks (D22/ADD-17): fresh location, online, approved, task capacity
 * and the COD cash limit are all authoritative DB state.
 */
export const RIDER_ELIGIBILITY = Symbol('RIDER_ELIGIBILITY');
export interface RiderEligibility {
  eligibleForDispatch(input: {
    riderIds: readonly string[];
    at: Date;
    /** When set, cash-in-hand + amount must stay under the configured limit. */
    codAmountPaise?: string;
    tx?: import('../../../platform/database/database.js').TransactionContext;
  }): Promise<Record<string, EligibilityResult>>;
}
