import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { RealtimeBroadcasts } from '../../tracking/contracts/tracking.js';
import type { DeliveryTaskCancellation, DeliveryTaskStatus } from '../contracts/tasks.js';
import { transitionTask } from '../domain/task-policy.js';
import {
  assignmentHistory,
  releaseRiderTask,
  taskEvent,
  taskHistory,
  type TaskRow,
} from './primitives.js';

/**
 * Compensating cancel used by the shared order cancellation routine (P6
 * contract, ADR 0011). Idempotent: cancelling an already terminal task is a
 * no-op. Revokes live offers, releases rider capacity and writes history +
 * events in the caller's transaction.
 */
export class PostgresDeliveryTaskCancellation implements DeliveryTaskCancellation {
  constructor(
    private readonly db: Database,
    private readonly broadcasts: RealtimeBroadcasts,
  ) {}

  async cancel(orderId: string, reason: string, outer?: TransactionContext): Promise<void> {
    if (!reason || reason.length > 300) throw new Error('INVALID_INPUT');
    const run = async (tx: TransactionContext) => {
      const tasks =
        await sql<TaskRow>`SELECT * FROM delivery_tasks WHERE order_id=${orderId}::uuid AND status NOT IN ('DELIVERED','FAILED','CANCELLED') ORDER BY created_at DESC FOR UPDATE`.execute(
          tx,
        );
      for (const task of tasks.rows) {
        transitionTask(task.status, 'CANCELLED');
        const now = await databaseTimeAfterLock(tx);
        await sql`UPDATE delivery_tasks SET status='CANCELLED',cancel_reason=${reason},rider_id=NULL,offered_rider_id=NULL,version=version+1 WHERE id=${task.id}::uuid`.execute(
          tx,
        );
        await taskHistory(tx, task.id, task.status, 'CANCELLED', null, reason);
        await taskEvent(
          tx,
          task.id,
          orderId,
          'delivery.task_changed',
          { previous: task.status, status: 'CANCELLED', reason },
          ['notifications'],
        );
        const revoked = await sql<{
          id: string;
          rider_id: string;
        }>`UPDATE rider_offers SET status='REVOKED'
          WHERE task_id=${task.id}::uuid AND status='SENT' RETURNING id,rider_id`.execute(tx);
        if (task.rider_id) await releaseRiderTask(tx, task.rider_id, now);
        for (const offer of revoked.rows) {
          await taskEvent(
            tx,
            task.id,
            orderId,
            'rider.offer_revoked',
            {
              riderId: offer.rider_id,
              offerId: offer.id,
              taskId: task.id,
              orderId,
              storeId: task.store_id,
              reason: 'ORDER_CANCELLED',
            },
            ['notifications', 'dispatch-realtime'],
          );
        }
        await assignmentHistory(
          tx,
          task.id,
          task.attempt_no,
          task.rider_id,
          'SYSTEM_UNASSIGNED',
          null,
          reason,
        );
      }
    };
    if (outer) await run(outer);
    else await transactionWithRetry(this.db, run);
  }
}

export type { DeliveryTaskStatus };
