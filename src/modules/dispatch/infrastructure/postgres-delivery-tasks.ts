import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { RealtimeBroadcasts } from '../../tracking/contracts/tracking.js';
import type { HandoverCodes } from '../../picking/contracts/packing.js';
import type { DeliveryTaskView, OfferPage, OfferView } from '../contracts/tasks.js';
import type { LockedOrder } from './primitives.js';
import {
  assignmentHistory,
  loadTask,
  lockOrder,
  mapTaskRow,
  operation,
  taskEvent,
  taskHistory,
  type TaskRow,
} from './primitives.js';
import type { DispatchSettings } from './settings.js';

interface OfferRow {
  id: string;
  task_id: string;
  order_id: string;
  store_id: string;
  attempt_no: number;
  expires_at: Date;
  amount_due_paise: string | null;
  payment_method: string | null;
}

function mapOffer(row: OfferRow): OfferView {
  return {
    offerId: row.id,
    taskId: row.task_id,
    orderId: row.order_id,
    storeId: row.store_id,
    attemptNo: row.attempt_no,
    expiresAt: row.expires_at.toISOString(),
    codAmountPaise: row.payment_method === 'COD' ? row.amount_due_paise : null,
  };
}

type Effect = () => void;
export interface TaskOutcome<T> {
  result: T;
  effects?: Effect[];
}
export type TaskRunner = <T>(fn: (tx: TransactionContext) => Promise<TaskOutcome<T>>) => Promise<T>;

/**
 * Rider-facing delivery task flows (P8): offers, atomic accept (SYS-05) and
 * the shared view projection. Locks follow the platform hierarchy: order →
 * delivery task → rider status, with databaseTimeAfterLock after every wait.
 * Realtime emissions are post-commit effects and never break order flow.
 */
export class PostgresDeliveryTasks {
  constructor(
    readonly db: Database,
    readonly settings: DispatchSettings,
    readonly broadcasts: RealtimeBroadcasts,
    readonly handoverCodes: HandoverCodes,
  ) {}

  async run<T>(fn: (tx: TransactionContext) => Promise<TaskOutcome<T>>): Promise<T> {
    const outcome = await transactionWithRetry(this.db, fn);
    for (const effect of outcome.effects ?? [])
      try {
        effect();
      } catch {
        // emissions are best-effort; HTTP polling is the fallback
      }
    return outcome.result;
  }

  async offers(riderId: string): Promise<OfferPage> {
    const rows =
      await sql<OfferRow>`SELECT o.id,o.task_id,t.order_id,t.store_id,o.attempt_no,o.expires_at,
      COALESCE((SELECT expected_amount_paise FROM cod_collections WHERE order_id=ord.id),ord.amount_due_paise)::text AS "amount_due_paise",ord.payment_method
      FROM rider_offers o
      JOIN delivery_tasks t ON t.id=o.task_id
      JOIN orders ord ON ord.id=t.order_id
      WHERE o.rider_id=${riderId}::uuid AND o.status='SENT' AND o.expires_at > clock_timestamp()
      ORDER BY o.sent_at, o.id LIMIT 20`.execute(this.db);
    return { items: rows.rows.map(mapOffer) };
  }

  async currentTask(riderId: string): Promise<DeliveryTaskView | null> {
    const rows = await sql<TaskRow>`SELECT t.* FROM delivery_tasks t
      WHERE t.rider_id=${riderId}::uuid AND t.status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')
      ORDER BY t.created_at DESC LIMIT 1`.execute(this.db);
    const row = rows.rows[0];
    if (!row) return null;
    return this.viewFor(row);
  }

  /** View with COD amount and the pre-pickup handover code (best effort). */
  async viewFor(row: TaskRow): Promise<DeliveryTaskView> {
    const order = await sql<{
      payment_method: string | null;
      amount_due_paise: string;
    }>`SELECT payment_method,COALESCE((SELECT expected_amount_paise FROM cod_collections WHERE order_id=orders.id),amount_due_paise)::text AS "amount_due_paise" FROM orders WHERE id=${row.order_id}::uuid`.execute(
      this.db,
    );
    const cod = order.rows[0];
    let handoverCode: string | null = null;
    if (row.status === 'ASSIGNED' || row.status === 'AT_STORE') {
      try {
        handoverCode = (await this.handoverCodes.presentCode(row.order_id)).code;
      } catch {
        handoverCode = null; // issued at accept; absent only before wiring lands
      }
    }
    return mapTaskRow(
      row,
      handoverCode,
      cod?.payment_method === 'COD' ? cod.amount_due_paise : null,
    );
  }

  async accept(riderId: string, offerId: string, reference: string): Promise<DeliveryTaskView> {
    const taskId = await this.run(async (tx) => {
      const initial = await sql<{
        task_id: string;
        order_id: string;
        rider_id: string;
      }>`SELECT o.task_id,t.order_id,o.rider_id FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE o.id=${offerId}::uuid`.execute(
        tx,
      );
      const identity = initial.rows[0];
      if (!identity || identity.rider_id !== riderId) throw new Error('RESOURCE_NOT_FOUND');
      const order = await lockOrder(tx, identity.order_id);
      const task = await loadTask(tx, identity.task_id, true);
      if (!order || !task) throw new Error('RESOURCE_NOT_FOUND');
      if (order.on_hold) throw new Error('ORDER_ON_HOLD');
      const lockedOffer = await sql<{
        rider_id: string;
        status: string;
        expires_at: Date;
      }>`SELECT rider_id,status,expires_at FROM rider_offers WHERE id=${offerId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const row = lockedOffer.rows[0];
      if (!row || row.rider_id !== riderId) throw new Error('RESOURCE_NOT_FOUND');
      if (!(await operation(tx, `offer-accept:${reference}`, 'OFFER_ACCEPT', { riderId, offerId })))
        return { result: task.id };
      if (!['CONFIRMED', 'PICKING', 'PACKED'].includes(order.status))
        throw new Error('OFFER_NO_LONGER_AVAILABLE');
      if (row.status !== 'SENT') throw new Error('OFFER_NO_LONGER_AVAILABLE');
      const now = await databaseTimeAfterLock(tx);
      if (row.expires_at.getTime() <= now.getTime()) throw new Error('OFFER_EXPIRED');
      if (task.status !== 'OFFERED' || task.offered_rider_id !== riderId)
        throw new Error('OFFER_NO_LONGER_AVAILABLE');
      await this.assertRiderCapacity(tx, riderId, order);
      const updated = await sql<{
        version: string;
      }>`UPDATE delivery_tasks SET status='ASSIGNED',rider_id=${riderId}::uuid,offered_rider_id=NULL,dispatched_at=COALESCE(dispatched_at,${now.toISOString()}::timestamptz),version=version+1
        WHERE id=${task.id}::uuid AND status='OFFERED' AND rider_id IS NULL RETURNING version::text AS "version"`.execute(
        tx,
      );
      if (!updated.rows[0]) throw new Error('OFFER_NO_LONGER_AVAILABLE');
      await sql`UPDATE rider_offers SET status='ACCEPTED',responded_at=${now.toISOString()}::timestamptz WHERE id=${offerId}::uuid`.execute(
        tx,
      );
      const revoked = await sql<{
        id: string;
        rider_id: string;
      }>`UPDATE rider_offers SET status='REVOKED'
        WHERE task_id=${task.id}::uuid AND status='SENT' AND id <> ${offerId}::uuid
        RETURNING id,rider_id`.execute(tx);
      await sql`UPDATE rider_status SET active_tasks=active_tasks+1,idle_since=NULL,unreachable_since=NULL,version=version+1
        WHERE rider_id=${riderId}::uuid`.execute(tx);
      for (const other of revoked.rows)
        await taskEvent(
          tx,
          task.id,
          task.order_id,
          'rider.offer_revoked',
          {
            riderId: other.rider_id,
            offerId: other.id,
            taskId: task.id,
            orderId: task.order_id,
            storeId: task.store_id,
            reason: 'ASSIGNED_ELSEWHERE',
          },
          ['notifications'],
        );
      await taskHistory(tx, task.id, 'OFFERED', 'ASSIGNED', riderId);
      await assignmentHistory(tx, task.id, task.attempt_no, riderId, 'ASSIGNED', riderId);
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'delivery.task_assigned',
        { riderId, attemptNo: task.attempt_no },
        ['notifications'],
      );
      await this.handoverCodes.issue(
        { orderId: task.order_id, storeId: task.store_id, riderId },
        tx,
      );
      const effects: Effect[] = [
        () =>
          this.broadcasts.emitRiderEvent(riderId, 'task.updated', {
            taskId: task.id,
            status: 'ASSIGNED',
          }),
        () =>
          this.broadcasts.emitOrderEvent(task.order_id, 'order.status', {
            status: 'ASSIGNED',
            taskId: task.id,
          }),
        ...revoked.rows.map(
          (other) => () =>
            this.broadcasts.emitRiderEvent(other.rider_id, 'offer.revoked', {
              offerId: other.id,
              taskId: task.id,
              reason: 'ASSIGNED_ELSEWHERE',
            }),
        ),
      ];
      return { result: task.id, effects };
    });
    if (!taskId) throw new Error('RESOURCE_NOT_FOUND');
    const task = await loadTask(this.db, taskId, false);
    if (!task) throw new Error('RESOURCE_NOT_FOUND');
    return this.viewFor(task);
  }

  async decline(
    riderId: string,
    offerId: string,
    reference: string,
  ): Promise<{ state: 'DECLINED' }> {
    return this.run(async (tx) => {
      const initial = await sql<{
        task_id: string;
        order_id: string;
        rider_id: string;
      }>`SELECT o.task_id,t.order_id,o.rider_id
        FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE o.id=${offerId}::uuid`.execute(
        tx,
      );
      if (!initial.rows[0] || initial.rows[0].rider_id !== riderId)
        throw new Error('RESOURCE_NOT_FOUND');
      const order = await lockOrder(tx, initial.rows[0].order_id);
      const task = await loadTask(tx, initial.rows[0].task_id, true);
      if (!order || !task) throw new Error('RESOURCE_NOT_FOUND');
      const locked = await sql<{
        task_id: string;
        status: string;
        rider_id: string;
      }>`SELECT task_id,status,rider_id FROM rider_offers WHERE id=${offerId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const offer = locked.rows[0];
      if (!offer || offer.rider_id !== riderId || offer.task_id !== task.id)
        throw new Error('RESOURCE_NOT_FOUND');
      if (
        !(await operation(tx, `offer-decline:${reference}`, 'OFFER_DECLINE', { riderId, offerId }))
      )
        return { result: { state: 'DECLINED' as const } };
      if (offer.status === 'SENT') {
        const now = await databaseTimeAfterLock(tx);
        await sql`UPDATE rider_offers SET status='DECLINED',responded_at=${now.toISOString()}::timestamptz WHERE id=${offerId}::uuid`.execute(
          tx,
        );
        if (task.status === 'OFFERED' && task.offered_rider_id === riderId) {
          await sql`UPDATE delivery_tasks SET status='UNASSIGNED',offered_rider_id=NULL,next_dispatch_at=clock_timestamp(),version=version+1 WHERE id=${task.id}::uuid`.execute(
            tx,
          );
          await taskHistory(tx, task.id, 'OFFERED', 'UNASSIGNED', riderId, 'offer declined');
        }
      }
      return { result: { state: 'DECLINED' as const } };
    });
  }

  async assertRiderCapacity(
    tx: TransactionContext,
    riderId: string,
    order: LockedOrder,
  ): Promise<void> {
    await sql`INSERT INTO rider_status(rider_id) VALUES(${riderId}::uuid) ON CONFLICT DO NOTHING`.execute(
      tx,
    );
    const rows = await sql<{
      online: boolean;
      active_tasks: number;
      on_break: boolean;
      last_location_at: Date | null;
      profile_status: string;
      user_status: string;
    }>`SELECT s.online,s.on_break,s.active_tasks,s.last_location_at,p.status AS profile_status,u.status AS user_status FROM rider_status s JOIN rider_profiles p ON p.user_id=s.rider_id JOIN users u ON u.id=s.rider_id WHERE s.rider_id=${riderId}::uuid FOR UPDATE OF s,p,u`.execute(
      tx,
    );
    const rider = rows.rows[0];
    if (!rider?.online) throw new Error('RIDER_OFFLINE');
    if (rider.on_break) throw new Error('RIDER_OFFLINE');
    if (rider.profile_status !== 'APPROVED' || rider.user_status !== 'ACTIVE')
      throw new Error('RIDER_NOT_APPROVED');
    const now = await databaseTimeAfterLock(tx);
    const staleSeconds = await this.settings.number('riderStaleLocationSeconds');
    if (
      !rider.last_location_at ||
      rider.last_location_at.getTime() < now.getTime() - staleSeconds * 1000
    )
      throw new Error('RIDER_STALE_LOCATION');
    const maxTasks = await this.settings.number('riderMaxConcurrentTasks');
    if (rider.active_tasks >= maxTasks) throw new Error('RIDER_AT_CAPACITY');
    if (order.payment_method === 'COD') {
      const cashLimit = await this.settings.paise('cashInHandLimitPaise');
      const held = await sql<{
        balance_after: string;
      }>`SELECT balance_after FROM rider_cash_ledger WHERE rider_id=${riderId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`.execute(
        tx,
      );
      const heldPaise = BigInt(held.rows[0]?.balance_after ?? '0');
      const pending = await sql<{
        amount: string;
      }>`SELECT COALESCE(sum(COALESCE(c.expected_amount_paise,o.amount_due_paise)),0)::text AS amount FROM delivery_tasks t JOIN orders o ON o.id=t.order_id LEFT JOIN cod_collections c ON c.order_id=o.id WHERE t.rider_id=${riderId}::uuid AND t.status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED') AND o.payment_method='COD' AND COALESCE(c.state,'PENDING')<>'COLLECTED'`.execute(
        tx,
      );
      if (
        heldPaise + BigInt(pending.rows[0]!.amount) + BigInt(order.amount_due_paise) >
        BigInt(cashLimit)
      )
        throw new Error('CASH_LIMIT_EXCEEDED');
    }
  }
}
