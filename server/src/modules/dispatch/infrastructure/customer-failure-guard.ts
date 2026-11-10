import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { DispatchSettings } from './settings.js';
import type { TaskRow } from './primitives.js';

/** The same persisted arrival and contacts govern rider and admin failure. */
export async function assertCustomerFailureReady(
  tx: TransactionContext,
  task: TaskRow,
  riderId: string,
  now: Date,
  settings: DispatchSettings,
): Promise<void> {
  if (task.status !== 'ARRIVED' || !task.arrived_customer_at) throw new Error('TASK_STATE_INVALID');
  const waitSeconds = await settings.number('deliveryFailureWaitSeconds');
  if (now.getTime() - task.arrived_customer_at.getTime() < waitSeconds * 1000)
    throw new Error('DELIVERY_WAIT_REQUIRED');
  const attempts = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM delivery_contact_attempts
    WHERE task_id=${task.id}::uuid AND rider_id=${riderId}::uuid AND attempt_no=${task.attempt_no}
    AND attempted_at>=${task.arrived_customer_at.toISOString()}::timestamptz`.execute(tx);
  if (
    Number(attempts.rows[0]!.count) < (await settings.number('deliveryFailureMinContactAttempts'))
  )
    throw new Error('DELIVERY_CONTACT_ATTEMPTS_REQUIRED');
}
