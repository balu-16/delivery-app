import { sql } from 'kysely';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { RealtimeBroadcasts } from '../../tracking/contracts/tracking.js';
import type { DeliveryTaskStatus } from '../contracts/tasks.js';
import { assignmentHistory, taskEvent, taskHistory } from './primitives.js';
import type { DispatchEngine } from './dispatch-engine.js';
import type { DispatchSettings } from './settings.js';

/**
 * Dispatch sweeps (idempotent): unreachable riders (D21) — before pickup the
 * task is unassigned and re-dispatched with attempt_no+1, after pickup custody
 * is preserved and an audited escalation event fires; plus the periodic
 * dispatch/offer-expiry rounds.
 */
export class DispatchMaintenance {
  constructor(
    private readonly db: Database,
    private readonly settings: DispatchSettings,
    private readonly engine: DispatchEngine,
    private readonly broadcasts: RealtimeBroadcasts,
  ) {}

  async runOnce(): Promise<{
    redispatched: number;
    escalated: number;
    expired: number;
    offered: number;
  }> {
    const offered = await this.engine.dispatchDue();
    const expired = await this.engine.expireOffers();
    const custody = await this.sweepUnreachable();
    return { offered, expired, ...custody };
  }

  private async sweepUnreachable(): Promise<{ redispatched: number; escalated: number }> {
    let redispatched = 0;
    let escalated = 0;
    const graceMinutes = await this.settings.number('riderRedispatchMinutes');
    const grace = new Date(Date.now() - graceMinutes * 60000).toISOString();
    const candidates = await sql<{
      task_id: string;
      order_id: string;
      status: string;
      rider_id: string;
      attempt_no: number;
    }>`SELECT t.id AS task_id,t.order_id,t.status,t.rider_id,t.attempt_no
      FROM delivery_tasks t JOIN rider_status s ON s.rider_id=t.rider_id
      WHERE s.unreachable_since IS NOT NULL AND s.unreachable_since < ${grace}::timestamptz
        AND t.status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')
      ORDER BY t.id LIMIT 100`.execute(this.db);
    for (const row of candidates.rows) {
      const result = await transactionWithRetry(this.db, async (tx) => {
        await sql`SELECT id FROM orders WHERE id=${row.order_id}::uuid FOR UPDATE`.execute(tx);
        const locked = await sql<{
          id: string;
          order_id: string;
          status: string;
          rider_id: string;
          attempt_no: number;
        }>`SELECT id,order_id,status,rider_id,attempt_no FROM delivery_tasks WHERE id=${row.task_id}::uuid FOR UPDATE`.execute(
          tx,
        );
        const task = locked.rows[0];
        if (!task || task.rider_id !== row.rider_id) return 'SKIP' as const;
        const rider = await sql<{
          unreachable_since: Date | null;
        }>`SELECT unreachable_since FROM rider_status WHERE rider_id=${task.rider_id}::uuid FOR UPDATE`.execute(
          tx,
        );
        const unreachableSince = rider.rows[0]?.unreachable_since;
        if (!unreachableSince || unreachableSince.getTime() >= Date.now() - graceMinutes * 60000)
          return 'SKIP' as const;
        const status = task.status as DeliveryTaskStatus;
        if (status === 'PICKED_UP' || status === 'ARRIVED') {
          // D21: custody is preserved; escalation is audited, never implied.
          await assignmentHistory(
            tx,
            task.id,
            task.attempt_no,
            task.rider_id,
            'ESCALATED',
            null,
            'rider unreachable after pickup',
          );
          await taskEvent(
            tx,
            task.id,
            task.order_id,
            'delivery.custody_escalation',
            { riderId: task.rider_id, unreachableSince: unreachableSince.toISOString() },
            ['notifications'],
          );
          await sql`UPDATE rider_status SET unreachable_since=NULL,version=version+1 WHERE rider_id=${task.rider_id}::uuid`.execute(
            tx,
          );
          return 'ESCALATED' as const;
        }
        if (status !== 'ASSIGNED' && status !== 'AT_STORE') return 'SKIP' as const;
        await sql`UPDATE delivery_tasks SET status='UNASSIGNED',rider_id=NULL,attempt_no=attempt_no+1,next_dispatch_at=clock_timestamp(),version=version+1 WHERE id=${task.id}::uuid`.execute(
          tx,
        );
        await taskHistory(
          tx,
          task.id,
          status,
          'UNASSIGNED',
          null,
          'rider unreachable before pickup',
        );
        await assignmentHistory(
          tx,
          task.id,
          task.attempt_no,
          task.rider_id,
          'SYSTEM_UNASSIGNED',
          null,
          'rider unreachable before pickup',
        );
        await taskEvent(
          tx,
          task.id,
          task.order_id,
          'delivery.task_changed',
          {
            previous: task.status,
            status: 'UNASSIGNED',
            attemptNo: task.attempt_no + 1,
            reason: 'RIDER_UNREACHABLE',
          },
          ['notifications'],
        );
        await sql`UPDATE rider_status SET active_tasks=GREATEST(active_tasks-1,0),idle_since=clock_timestamp(),version=version+1 WHERE rider_id=${task.rider_id}::uuid`.execute(
          tx,
        );
        return 'REDISPATCHED' as const;
      }).catch(() => 'SKIP' as const);
      if (result === 'REDISPATCHED') {
        redispatched += 1;
        await this.emitRedispatchAlert(row.task_id, row.order_id, 'RIDER_UNREACHABLE_REDISPATCH');
      } else if (result === 'ESCALATED') escalated += 1;
    }
    return { redispatched, escalated };
  }

  /** Task-scoped alert event; the outbox unique key stays collision-free. */
  private async emitRedispatchAlert(taskId: string, orderId: string, kind: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await taskEvent(tx, taskId, orderId, 'dispatch.rider_unreachable', { kind }, [
        'notifications',
      ]);
    });
    this.broadcasts.emitOrderEvent(orderId, 'order.status', { status: 'RIDER_REDISPATCH' });
  }
}
