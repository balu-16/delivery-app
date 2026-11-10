import type { TransactionContext } from '../../../platform/database/database.js';

export const STORE_AVAILABILITY = Symbol('STORE_AVAILABILITY');
export const STORE_SIGNALS = Symbol('STORE_SIGNALS');
export interface StoreSignals {
  noRiders(storeId: string, at: Date, tx?: TransactionContext): Promise<boolean>;
  /** Called by operational ingestion when backlog or rider availability changes. */
  observe(
    storeId: string,
    pickBacklog: number,
    ridersAvailable: boolean,
    correlationId: string,
  ): Promise<void>;
  /** Scheduler calls this repeatedly; processing is idempotent under store locks. */
  evaluateDue(correlationId: string, limit?: number): Promise<number>;
}
