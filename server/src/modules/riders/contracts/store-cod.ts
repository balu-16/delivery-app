/**
 * Store-portal COD views (P10). Every read is store-scoped through
 * assertStoreRole; rider identities only ever surface when they are linked to
 * the store via delivery activity or a recorded COD settlement.
 */

/**
 * Eligible-COD-deposit rider: a rider with delivery activity on the store
 * (any delivery_tasks row with rider_id set for the store) or at least one
 * COD settlement recorded at the store. A rider holding un-deposited cash
 * still settles even if suspended or offline, so profile status is not
 * filtered here; the cash figures come from the same rider_cash_ledger
 * balance the dispatch COD limit uses.
 */
export interface StoreCodRiderItem {
  userId: string;
  name: string;
  cashInHandPaise: string;
  /** null when the limit cannot be displayed (unset config). */
  limitPaise: string | null;
  hasOutstanding: boolean;
}
export interface StoreCodRiderPage {
  items: StoreCodRiderItem[];
  nextCursor: string | null;
}

export interface StoreCodDepositItem {
  id: string;
  riderId: string;
  riderName: string;
  amountPaise: string;
  discrepancyPaise: string;
  depositReference: string;
  status: 'PENDING' | 'CLEARED';
  createdAt: Date;
}
/** Aggregates cover the whole matching set, not just the returned page. */
export interface StoreCodDepositTotals {
  depositedPaise: string;
  discrepancyPaise: string;
  count: number;
}
export interface StoreCodDepositPage {
  items: StoreCodDepositItem[];
  nextCursor: string | null;
  totals: StoreCodDepositTotals;
}

export const STORE_COD_READS = Symbol('STORE_COD_READS');
export interface StoreCodReads {
  eligibleRiders(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<StoreCodRiderPage>;
  deposits(
    actorId: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit?: number,
  ): Promise<StoreCodDepositPage>;
}
