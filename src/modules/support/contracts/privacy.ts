import type { TransactionContext } from '../../../platform/database/database.js';
export const P11_PRIVACY = Symbol('P11_PRIVACY');
export interface P11Privacy {
  exportForUser(
    userId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  anonymizeUser(userId: string, tx: TransactionContext): Promise<void>;
}
