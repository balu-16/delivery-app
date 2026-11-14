import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { evaluateCod } from '../contracts/checkout.js';

/** Quote and placement use the same policy inputs; placement supplies its transaction. */
export async function codEligibility(
  db: Database,
  config: AppConfig,
  userId: string,
  storeId: string,
  amountDuePaise: string,
  tx?: TransactionContext,
) {
  const connection = tx ?? db;
  const [flag, store, completed, maxCodPaise, eligibility] = await Promise.all([
    sql<{ enabled: boolean }>`SELECT enabled FROM feature_flags WHERE key='cod_enabled'`.execute(
      connection,
    ),
    sql<{ accepts_cod: boolean }>`SELECT accepts_cod FROM stores WHERE id=${storeId}::uuid`.execute(
      connection,
    ),
    sql<{ n: string }>`SELECT count(*)::text AS n FROM orders WHERE user_id=${userId}::uuid
      AND status='DELIVERED' AND payment_status='PAID' AND payment_method IN ('GATEWAY','WALLET','ZERO_DUE')`.execute(
      connection,
    ),
    config.get('maxCodPaise', tx),
    config.get('codEligibility', tx),
  ]);
  return evaluateCod({
    codEnabled: flag.rows[0]?.enabled === true,
    storeAcceptsCod: store.rows[0]?.accepts_cod === true,
    amountDuePaise,
    maxCodPaise,
    completedPrepaidOrders: Number(completed.rows[0]?.n ?? '0'),
    minCompletedPrepaidOrders: eligibility.minCompletedPrepaidOrders,
  });
}
