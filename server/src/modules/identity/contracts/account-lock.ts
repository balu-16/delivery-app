import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';

/** Serialize new obligations with account erasure for either identity pool. */
export async function lockActiveAccount(userId: string, tx: TransactionContext): Promise<void> {
  const result = await sql<{ id: string }>`SELECT id FROM users
    WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(tx);
  if (!result.rows.length) throw new Error('ACCOUNT_DISABLED');
}

/** Acquire before subscription, order, wallet or other obligation locks. */
export async function lockActiveCustomer(userId: string, tx: TransactionContext): Promise<void> {
  const result = await sql<{ id: string }>`SELECT id FROM users
    WHERE id=${userId}::uuid AND pool='CUSTOMER' AND status='ACTIVE' FOR UPDATE`.execute(tx);
  if (!result.rows.length) throw new Error('ACCOUNT_DISABLED');
}
