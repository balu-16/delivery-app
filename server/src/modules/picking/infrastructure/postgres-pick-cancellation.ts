import { sql } from 'kysely';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { PickCancellation, PickTaskStatus } from '../contracts/tasks.js';
import { taskEvent, taskHistory } from './pick-primitives.js';
import { transitionTask } from '../domain/policy.js';

/**
 * Compensating cancel used by the shared order cancellation routine (P6
 * contract) and by all-short system cancels. Idempotent: cancelling an
 * already cancelled or completed task is a no-op.
 */
export class PostgresPickCancellation implements PickCancellation {
  constructor(private readonly db: Database) {}
  async cancel(orderId: string, reason: string, outer?: TransactionContext): Promise<void> {
    if (!reason || reason.length > 300) throw new Error('INVALID_INPUT');
    const run = async (tx: TransactionContext) => {
      const tasks = await sql<{
        id: string;
        status: PickTaskStatus;
      }>`SELECT id,status FROM pick_tasks WHERE order_id=${orderId}::uuid AND status IN ('PENDING','ASSIGNED','IN_PROGRESS') ORDER BY created_at DESC FOR UPDATE`.execute(
        tx,
      );
      for (const task of tasks.rows) {
        transitionTask(task.status, 'CANCELLED');
        await sql`UPDATE pick_tasks SET status='CANCELLED',cancel_reason=${reason},version=version+1 WHERE id=${task.id}::uuid`.execute(
          tx,
        );
        await taskHistory(tx, task.id, task.status, 'CANCELLED', null, reason);
        await taskEvent(
          tx,
          task.id,
          orderId,
          'picking.task_changed',
          {
            previous: task.status,
            status: 'CANCELLED',
            reason,
          },
          ['notifications'],
        );
      }
    };
    if (outer) await run(outer);
    else await transactionWithRetry(this.db, run);
  }
}
