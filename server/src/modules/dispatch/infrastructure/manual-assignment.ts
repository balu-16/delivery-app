import { sql } from 'kysely';
import type { DeliveryAssignment, DeliveryTaskView } from '../contracts/tasks.js';
import {
  loadTask,
  lockOrder,
  operation,
  releaseRiderTask,
  assignmentHistory,
  taskHistory,
  taskEvent,
} from './primitives.js';
import type { PostgresDeliveryTasks } from './postgres-delivery-tasks.js';
import { uuidV7 } from '../../../common/ids/ids.js';

/** Audited pre-pickup repair uses the same locked eligibility checks as offer acceptance. */
export class ManualAssignment implements DeliveryAssignment {
  constructor(private readonly tasks: PostgresDeliveryTasks) {}
  async assign(
    orderId: string,
    riderId: string,
    actorId: string,
    reason: string,
    reference: string,
  ): Promise<DeliveryTaskView> {
    if (!reason.trim() || reason.length > 300) throw new Error('INVALID_INPUT');
    const id = await this.tasks.run(async (tx) => {
      const allowed = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
     WHERE u.id=${actorId}::uuid AND u.status='ACTIVE' AND r.role IN ('ADMIN','SUPER_ADMIN') FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!allowed.rows.length) throw new Error('FORBIDDEN');
      const order = await lockOrder(tx, orderId);
      const projection = await sql<{
        id: string;
      }>`SELECT id FROM delivery_tasks WHERE order_id=${orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(
        tx,
      );
      if (!order || !projection.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (order.on_hold) throw new Error('ORDER_ON_HOLD');
      const task = await loadTask(tx, projection.rows[0].id, true);
      if (!task) throw new Error('RESOURCE_NOT_FOUND');
      if (
        !(await operation(tx, `manual-assign:${actorId}:${reference}`, 'MANUAL_ASSIGN', {
          orderId,
          riderId,
          reason,
        }))
      )
        return { result: task.id };
      if (
        !['CONFIRMED', 'PICKING', 'PACKED'].includes(order.status) ||
        task.pickup_at ||
        !['UNASSIGNED', 'OFFERED', 'ASSIGNED', 'AT_STORE'].includes(task.status)
      )
        throw new Error('TASK_STATE_INVALID');
      if (task.rider_id === riderId) return { result: task.id };
      await sql`SELECT rider_id FROM rider_status WHERE rider_id=ANY(${[riderId, ...(task.rider_id ? [task.rider_id] : [])].sort()}::uuid[]) ORDER BY rider_id FOR UPDATE`.execute(
        tx,
      );
      await this.tasks.assertRiderCapacity(tx, riderId, order);
      const now = new Date();
      if (task.rider_id) await releaseRiderTask(tx, task.rider_id, now);
      const revoked = await sql<{
        id: string;
        rider_id: string;
      }>`UPDATE rider_offers SET status='REVOKED',responded_at=clock_timestamp()
     WHERE task_id=${task.id}::uuid AND status='SENT' RETURNING id,rider_id`.execute(tx);
      await sql`UPDATE delivery_tasks SET status='ASSIGNED',rider_id=${riderId}::uuid,offered_rider_id=NULL,arrived_store_at=NULL,
     attempt_no=attempt_no+1,dispatched_at=COALESCE(dispatched_at,clock_timestamp()),version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE rider_status SET active_tasks=active_tasks+1,idle_since=NULL,unreachable_since=NULL,version=version+1 WHERE rider_id=${riderId}::uuid`.execute(
        tx,
      );
      await this.tasks.handoverCodes.issue({ orderId, storeId: task.store_id, riderId }, tx);
      for (const offer of revoked.rows)
        await taskEvent(
          tx,
          task.id,
          orderId,
          'rider.offer_revoked',
          { riderId: offer.rider_id, offerId: offer.id, reason: 'MANUAL_ASSIGNMENT' },
          ['notifications'],
        );
      await taskHistory(tx, task.id, task.status, 'ASSIGNED', actorId, reason);
      await assignmentHistory(
        tx,
        task.id,
        task.attempt_no + 1,
        riderId,
        task.rider_id ? 'REASSIGNED' : 'ASSIGNED',
        actorId,
        reason,
      );
      await taskEvent(
        tx,
        task.id,
        orderId,
        'delivery.task_assigned',
        { riderId, attemptNo: task.attempt_no + 1, reason },
        ['notifications'],
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
     VALUES(${uuidV7()}::uuid,${actorId}::uuid,'dispatch.manual_assignment','order',${orderId},${JSON.stringify({ riderId, previousRiderId: task.rider_id, reason })}::jsonb)`.execute(
        tx,
      );
      return {
        result: task.id,
        effects: [
          () =>
            this.tasks.broadcasts.emitRiderEvent(riderId, 'task.updated', {
              taskId: task.id,
              orderId,
              status: 'ASSIGNED',
            }),
          ...(task.rider_id
            ? [
                () =>
                  this.tasks.broadcasts.emitRiderEvent(task.rider_id!, 'task.updated', {
                    taskId: task.id,
                    orderId,
                    status: 'REASSIGNED',
                  }),
              ]
            : []),
        ],
      };
    });
    const row = await loadTask(this.tasks.db, id, false);
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    return this.tasks.viewFor(row);
  }
}
