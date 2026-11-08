import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { RealtimeBroadcasts } from '../../tracking/contracts/tracking.js';
import type { OrderDelivery } from '../contracts/dependencies.js';
import type { WrongAddress } from '../contracts/tasks.js';
import { assertCustomerFailureReady } from './customer-failure-guard.js';
import { loadTask, lockOrder, operation, taskEvent, taskHistory } from './primitives.js';
import type { TaskRunner } from './postgres-delivery-tasks.js';
import type { DispatchSettings } from './settings.js';

function validate(reason: string, reference: string): void {
  if (!reason?.trim() || reason.length > 300 || !reference || reference.length > 150)
    throw new Error('INVALID_INPUT');
}

export class PostgresWrongAddress implements WrongAddress {
  constructor(
    private readonly run: TaskRunner,
    private readonly settings: DispatchSettings,
    private readonly orders: OrderDelivery,
    private readonly broadcasts: RealtimeBroadcasts,
  ) {}

  async flag(
    riderId: string,
    taskId: string,
    reason: string,
    reference: string,
  ): Promise<{ flagId: string }> {
    validate(reason, reference);
    return this.run(async (tx) => {
      const initial = await loadTask(tx, taskId, false);
      if (!initial || !(await lockOrder(tx, initial.order_id)))
        throw new Error('RESOURCE_NOT_FOUND');
      const task = await loadTask(tx, taskId, true);
      if (!task || task.rider_id !== riderId) throw new Error('RESOURCE_NOT_FOUND');
      const fresh = await operation(
        tx,
        `wrong-address-flag:${taskId}:${riderId}:${reference}`,
        'WRONG_ADDRESS_FLAG',
        { taskId, riderId, reason },
      );
      const existing = await sql<{
        id: string;
        rider_id: string;
        reason: string;
      }>`SELECT id,rider_id,reason FROM delivery_wrong_address_flags WHERE task_id=${taskId}::uuid`.execute(
        tx,
      );
      if (!fresh) {
        if (!existing.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
        return { result: { flagId: existing.rows[0].id } };
      }
      if (task.status !== 'ARRIVED' || !task.pickup_at) throw new Error('TASK_STATE_INVALID');
      if (existing.rows[0]) {
        if (existing.rows[0].rider_id !== riderId || existing.rows[0].reason !== reason)
          throw new Error('RESOURCE_CONFLICT');
        return { result: { flagId: existing.rows[0].id } };
      }
      const id = uuidV7();
      await sql`INSERT INTO delivery_wrong_address_flags(id,task_id,rider_id,reason) VALUES(${id}::uuid,${taskId}::uuid,${riderId}::uuid,${reason})`.execute(
        tx,
      );
      await taskEvent(
        tx,
        taskId,
        task.order_id,
        'delivery.wrong_address_flagged',
        { riderId, flagId: id },
        ['notifications'],
      );
      return { result: { flagId: id } };
    });
  }

  async resolve(
    adminId: string,
    orderId: string,
    reason: string,
    reference: string,
  ): Promise<{ flagId: string; status: 'FAILED' }> {
    validate(reason, reference);
    return this.run(async (tx) => {
      const allowed = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.id=${adminId}::uuid AND u.status='ACTIVE' AND r.role IN ('ADMIN','SUPER_ADMIN') FOR SHARE OF u,r`.execute(
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
      const task = await loadTask(tx, projection.rows[0].id, true);
      if (!task) throw new Error('RESOURCE_NOT_FOUND');
      const flag = await sql<{
        id: string;
        rider_id: string;
        reason: string;
        resolved_at: Date | null;
      }>`SELECT id,rider_id,reason,resolved_at FROM delivery_wrong_address_flags WHERE task_id=${task.id}::uuid FOR UPDATE`.execute(
        tx,
      );
      const row = flag.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (
        !(await operation(
          tx,
          `wrong-address-resolve:${orderId}:${adminId}:${reference}`,
          'WRONG_ADDRESS_RESOLVE',
          { orderId, adminId, reason },
        ))
      )
        return { result: { flagId: row.id, status: 'FAILED' as const } };
      if (row.resolved_at || task.rider_id !== row.rider_id) throw new Error('TASK_STATE_INVALID');
      const now = await databaseTimeAfterLock(tx);
      await assertCustomerFailureReady(tx, task, row.rider_id, now, this.settings);
      await this.orders.markDeliveryFailed(
        orderId,
        adminId,
        'WRONG_ADDRESS',
        { flagId: row.id },
        tx,
        'ADMIN',
      );
      await sql`UPDATE delivery_tasks SET status='FAILED',failure_reason='WRONG_ADDRESS',failure_evidence=${JSON.stringify({ flagId: row.id })}::jsonb,version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE delivery_wrong_address_flags SET resolved_at=${now.toISOString()}::timestamptz,resolved_by=${adminId}::uuid,resolution_reason=${reason} WHERE id=${row.id}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, task.id, task.status, 'FAILED', adminId, reason);
      await taskEvent(
        tx,
        task.id,
        orderId,
        'delivery.failed',
        { riderId: row.rider_id, reason: 'WRONG_ADDRESS', custodyPreserved: true },
        ['notifications'],
      );
      await auditResolution(tx, adminId, orderId, row.id, reason);
      return {
        result: { flagId: row.id, status: 'FAILED' as const },
        effects: [
          () =>
            this.broadcasts.emitRiderEvent(row.rider_id, 'task.updated', {
              taskId: task.id,
              orderId,
              status: 'FAILED',
            }),
          () =>
            this.broadcasts.emitOrderEvent(orderId, 'order.status', {
              taskId: task.id,
              status: 'FAILED',
            }),
        ],
      };
    });
  }
}

async function auditResolution(
  tx: TransactionContext,
  adminId: string,
  orderId: string,
  flagId: string,
  reason: string,
): Promise<void> {
  await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
    VALUES(${uuidV7()}::uuid,${adminId}::uuid,'dispatch.wrong_address_resolved','order',${orderId},${JSON.stringify({ flagId, reason, resolution: 'FAILURE' })}::jsonb)`.execute(
    tx,
  );
}
