import type { TransactionContext } from '../../../platform/database/database.js';
export const REPORT_KINDS = [
  'catalog',
  'stock',
  'financial',
  'picking',
  'rider',
  'subscription',
  'support',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export interface ReportFilters {
  storeId?: string;
  from?: string;
  to?: string;
}
export interface ReportData {
  /** Caller supplies a read-only repeatable-read transaction for a consistent export attempt. */
  page(
    kind: ReportKind,
    cursor: string | null,
    limit: number,
    tx: TransactionContext,
    filters?: ReportFilters,
  ): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }>;
}
export const REPORT_DATA = Symbol('REPORT_DATA');
