import type { TransactionContext } from '../../../platform/database/database.js';
export const PAYOUTS = Symbol('PAYOUTS');
export interface Payouts {
  list(
    actorId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  draft(riderId: string, cutoff: string): Promise<string | null>;
  cancel(actorId: string, payoutId: string): Promise<void>;
  requestApproval(actorId: string, payoutId: string): Promise<string>;
  approve(actorId: string, approvalId: string): Promise<void>;
  markPaid(input: {
    actorId: string;
    payoutId: string;
    paymentReference: string;
    evidenceMediaId: string;
    idempotencyKey: string;
  }): Promise<void>;
  listCorrections(
    actorId: string,
    payoutId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  requestCorrection(input: {
    actorId: string;
    payoutId: string;
    deltaPaise: string;
    reason: string;
    reference: string;
  }): Promise<string>;
  settleCorrection(input: {
    actorId: string;
    correctionId: string;
    paymentReference: string;
    evidenceMediaId: string;
    idempotencyKey: string;
  }): Promise<void>;
  hasUnsettledPayout(riderId: string, tx?: TransactionContext): Promise<boolean>;
}
