import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { RecipientStrategy } from '../domain/matrix.js';

const UUID = /^[0-9a-f-]{36}$/i;
const MAX_ADMIN_RECIPIENTS = 500;

/**
 * Resolves recipient ids from payload data inside the consumer transaction.
 * Every query is bounded; unresolvable payloads yield an empty list (skip).
 */
export async function resolveRecipients(
  tx: TransactionContext,
  strategy: RecipientStrategy,
  ids: { userId: string | null; orderId: string | null; storeId: string | null },
): Promise<string[]> {
  switch (strategy) {
    case 'USER': {
      if (!ids.userId || !UUID.test(ids.userId)) return [];
      const rows = await sql<{
        id: string;
      }>`SELECT id FROM users WHERE id=${ids.userId}::uuid AND status='ACTIVE'`.execute(tx);
      return rows.rows.map((row) => row.id);
    }
    case 'ORDER_OWNER': {
      if (!ids.orderId || !UUID.test(ids.orderId)) return [];
      const rows = await sql<{
        user_id: string;
      }>`SELECT o.user_id FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=${ids.orderId}::uuid AND u.status='ACTIVE'`.execute(
        tx,
      );
      return rows.rows.map((row) => row.user_id);
    }
    case 'STORE_MANAGERS': {
      if (!ids.storeId || !UUID.test(ids.storeId)) return [];
      const rows = await sql<{
        user_id: string;
      }>`SELECT s.user_id FROM store_staff s JOIN users u ON u.id=s.user_id WHERE s.store_id=${ids.storeId}::uuid AND s.role='STORE_MANAGER' AND u.status='ACTIVE' ORDER BY s.user_id LIMIT ${MAX_ADMIN_RECIPIENTS}`.execute(
        tx,
      );
      return rows.rows.map((row) => row.user_id);
    }
    case 'ADMINS': {
      const rows = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role IN ('ADMIN','SUPER_ADMIN') AND u.status='ACTIVE' ORDER BY u.id LIMIT ${MAX_ADMIN_RECIPIENTS}`.execute(
        tx,
      );
      return rows.rows.map((row) => row.id);
    }
  }
}

/** Display locale: customer profile wins, everyone else gets English. */
export async function userLocale(tx: TransactionContext, userId: string): Promise<string | null> {
  const rows = await sql<{
    locale: string;
  }>`SELECT locale FROM customer_profiles WHERE user_id=${userId}::uuid`.execute(tx);
  return rows.rows[0]?.locale ?? null;
}
