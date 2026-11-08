import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { EtaProvider, RealtimeBroadcasts } from '../../tracking/contracts/tracking.js';
import { haversineMetres } from '../domain/geo.js';
import type { HandoverStatus } from '../../picking/contracts/packing.js';
import type {
  ContactView,
  DeliverInput,
  DeliveryTaskView,
  DeliveryCodes,
  FailInput,
} from '../contracts/tasks.js';
import type { OrderDelivery, OrderDeliveryReads } from '../contracts/dependencies.js';
import type { CodCollections, RiderEarnings } from '../../riders/contracts/riders.js';
import {
  assertFailReason,
  assertOperationReference,
  contactVisible,
  failEndsCustody,
  geofenceFlag,
  transitionTask,
} from '../domain/task-policy.js';
import {
  assignmentHistory,
  loadTask,
  lockOrder,
  mapTaskRow,
  operation,
  releaseRiderTask,
  taskEvent,
  taskHistory,
  type TaskRow,
} from './primitives.js';
import type { DispatchSettings } from './settings.js';
import type { TaskOutcome } from './postgres-delivery-tasks.js';
import type { TaskRunner } from './postgres-delivery-tasks.js';
import { assertCustomerFailureReady } from './customer-failure-guard.js';

/** Terminal delivery-task statuses (custody ended; rider id is cleared). */

/** Internal marker carrying the mismatch facts out of the rolled-back tx. */
class CodMismatchError extends Error {
  constructor(
    readonly orderId: string,
    readonly expectedPaise: string,
    readonly collectedPaise: string,
  ) {
    super('COD_AMOUNT_MISMATCH');
  }
}

type Effect = () => void;

/**
 * Custody transitions (23.3): store arrival (geofence-flagged), verified
 * handover pickup, customer arrival, delivery completion (code/POD, COD
 * settlement, earnings exactly once) and failure handling (pre-pickup
 * re-dispatch with attempt_no+1; post-pickup audited FAILED, custody kept).
 */
export class PostgresTaskActions {
  constructor(
    readonly db: Database,
    readonly settings: DispatchSettings,
    readonly broadcasts: RealtimeBroadcasts,
    readonly handoverStatus: HandoverStatus,
    readonly orderDelivery: OrderDelivery,
    readonly orderReads: OrderDeliveryReads,
    readonly cod: CodCollections,
    readonly earnings: RiderEarnings,
    readonly codes: DeliveryCodes,
    readonly eta: EtaProvider,
    readonly dispatchNext: (orderId: string) => Promise<void>,
    private readonly runner: TaskRunner,
  ) {}

  private run<T>(fn: (tx: TransactionContext) => Promise<TaskOutcome<T>>): Promise<T> {
    return this.runner(fn);
  }

  private async requireOwnTask(
    tx: TransactionContext,
    riderId: string,
    taskId: string,
  ): Promise<{ task: TaskRow; order: NonNullable<Awaited<ReturnType<typeof lockOrder>>> }> {
    const initial = await loadTask(tx, taskId, false);
    if (!initial) throw new Error('RESOURCE_NOT_FOUND');
    const order = await lockOrder(tx, initial.order_id);
    if (!order) throw new Error('RESOURCE_NOT_FOUND');
    const task = await loadTask(tx, taskId, true);
    if (!task) throw new Error('RESOURCE_NOT_FOUND');
    // Terminal rows clear the custody rider; ownership then rides on the
    // transition guard (any custody action on a terminal task is rejected).
    if (task.rider_id !== riderId) throw new Error('RESOURCE_NOT_FOUND');
    return { task, order };
  }

  private async storePoint(tx: TransactionContext, storeId: string) {
    const rows = await sql<{
      lat: string;
      lng: string;
    } | null>`SELECT ST_Y(location::geometry)::text AS lat,ST_X(location::geometry)::text AS lng
      FROM stores WHERE id=${storeId}::uuid`.execute(tx);
    const row = rows.rows[0];
    return row ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
  }

  private emitTaskStatus(
    task: { id: string; order_id: string; rider_id: string | null; status: string },
    effects: Effect[],
  ): void {
    if (task.rider_id)
      effects.push(() =>
        this.broadcasts.emitRiderEvent(task.rider_id!, 'task.updated', {
          taskId: task.id,
          orderId: task.order_id,
          status: task.status,
        }),
      );
    effects.push(() =>
      this.broadcasts.emitOrderEvent(task.order_id, 'order.status', {
        taskId: task.id,
        status: task.status,
      }),
    );
  }

  private async finalView(taskId: string): Promise<DeliveryTaskView> {
    const task = await loadTask(this.db, taskId, false);
    if (!task) throw new Error('RESOURCE_NOT_FOUND');
    const order = await sql<{
      payment_method: string | null;
      amount_due_paise: string;
    }>`SELECT payment_method,COALESCE((SELECT expected_amount_paise FROM cod_collections WHERE order_id=orders.id),amount_due_paise)::text AS "amount_due_paise" FROM orders WHERE id=${task.order_id}::uuid`.execute(
      this.db,
    );
    const cod = order.rows[0];
    return mapTaskRow(task, null, cod?.payment_method === 'COD' ? cod.amount_due_paise : null);
  }

  async arrivedAtStore(
    riderId: string,
    taskId: string,
    reference: string,
    point?: { lat: number; lng: number },
  ): Promise<DeliveryTaskView> {
    assertOperationReference(reference);
    const id = await this.run(async (tx) => {
      const { task } = await this.requireOwnTask(tx, riderId, taskId);
      if (!(await operation(tx, `arrive-store:${reference}`, 'ARRIVE_STORE', { taskId })))
        return { result: taskId };
      transitionTask(task.status, 'AT_STORE');
      const now = await databaseTimeAfterLock(tx);
      let geofence: number | null = null;
      if (point) {
        const store = await this.storePoint(tx, task.store_id);
        if (store) {
          const metres = haversineMetres(store, point);
          geofence = geofenceFlag(metres, await this.settings.number('geofenceThresholdMetres'));
        }
      }
      await sql`UPDATE delivery_tasks SET status='AT_STORE',arrived_store_at=${now.toISOString()}::timestamptz,geofence_store_distance_m=${geofence},version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, task.id, task.status, 'AT_STORE', riderId, 'arrived at store');
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'delivery.task_changed',
        { previous: task.status, status: 'AT_STORE' },
        ['notifications'],
      );
      const effects: Effect[] = [];
      this.emitTaskStatus({ ...task, status: 'AT_STORE' }, effects);
      return { result: task.id, effects };
    });
    return this.finalView(id);
  }

  async pickedUp(riderId: string, taskId: string, reference: string): Promise<DeliveryTaskView> {
    assertOperationReference(reference);
    const id = await this.run(async (tx) => {
      const { task, order } = await this.requireOwnTask(tx, riderId, taskId);
      if (order.on_hold) throw new Error('ORDER_ON_HOLD');
      if (!(await operation(tx, `pickup:${reference}`, 'PICKUP', { taskId })))
        return { result: taskId };
      if (task.status !== 'AT_STORE') throw new Error('HANDOVER_NOT_VERIFIED');
      if (!(await this.handoverStatus.verified(task.order_id)))
        throw new Error('HANDOVER_NOT_VERIFIED');
      transitionTask(task.status, 'PICKED_UP');
      await this.orderDelivery.markPickedUp(task.order_id, riderId, tx);
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'ORDER_OUT_FOR_DELIVERY',
        { orderId: task.order_id, riderId },
        ['notifications'],
      );
      const now = await databaseTimeAfterLock(tx);
      await sql`UPDATE delivery_tasks SET status='PICKED_UP',pickup_at=${now.toISOString()}::timestamptz,version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, task.id, task.status, 'PICKED_UP', riderId, 'handover verified');
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'delivery.task_changed',
        { previous: task.status, status: 'PICKED_UP' },
        ['notifications'],
      );
      const effects: Effect[] = [];
      const updated = { ...task, status: 'PICKED_UP' as const, pickup_at: now };
      this.emitTaskStatus(updated, effects);
      await this.publishEta(tx, updated, effects, true);
      return { result: task.id, effects };
    });
    return this.finalView(id);
  }

  async arrived(
    riderId: string,
    taskId: string,
    reference: string,
    point?: { lat: number; lng: number },
  ): Promise<DeliveryTaskView> {
    assertOperationReference(reference);
    const id = await this.run(async (tx) => {
      const { task } = await this.requireOwnTask(tx, riderId, taskId);
      if (!(await operation(tx, `arrive-customer:${reference}`, 'ARRIVE_CUSTOMER', { taskId })))
        return { result: taskId };
      transitionTask(task.status, 'ARRIVED');
      const now = await databaseTimeAfterLock(tx);
      let geofence: number | null = null;
      if (point) {
        const summary = await this.orderReads.orderSummary(task.order_id);
        const destination = summary?.addressSnapshot;
        if (destination?.lat !== undefined && destination?.lng !== undefined) {
          const metres = haversineMetres({ lat: destination.lat, lng: destination.lng }, point);
          geofence = geofenceFlag(metres, await this.settings.number('geofenceThresholdMetres'));
        }
      }
      await sql`UPDATE delivery_tasks SET status='ARRIVED',arrived_customer_at=${now.toISOString()}::timestamptz,geofence_customer_distance_m=${geofence},version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, task.id, task.status, 'ARRIVED', riderId, 'arrived at customer');
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'delivery.task_changed',
        { previous: task.status, status: 'ARRIVED' },
        ['notifications'],
      );
      const effects: Effect[] = [];
      const updated = { ...task, status: 'ARRIVED' as const };
      this.emitTaskStatus(updated, effects);
      return { result: task.id, effects };
    });
    return this.finalView(id);
  }

  async deliver(
    riderId: string,
    taskId: string,
    input: DeliverInput,
    reference: string,
  ): Promise<DeliveryTaskView> {
    assertOperationReference(reference);
    if (!input.deliveryCode && !input.podMediaId) throw new Error('DELIVERY_PROOF_REQUIRED');
    try {
      return await this.deliverInner(riderId, taskId, input, reference);
    } catch (error) {
      if (error instanceof CodMismatchError) {
        await this.recordCodMismatch(error.orderId, error.expectedPaise, error.collectedPaise);
        throw new Error('COD_AMOUNT_MISMATCH', { cause: error });
      }
      throw error;
    }
  }

  private async deliverInner(
    riderId: string,
    taskId: string,
    input: DeliverInput,
    reference: string,
  ): Promise<DeliveryTaskView> {
    {
      const id = await this.run(async (tx) => {
        const { task, order } = await this.requireOwnTask(tx, riderId, taskId);
        if (!(await operation(tx, `deliver:${reference}`, 'DELIVER', { taskId, input })))
          return { result: taskId };
        if (task.status !== 'ARRIVED') throw new Error('TASK_STATE_INVALID');
        if (input.deliveryCode) await this.codes.verify(task.order_id, input.deliveryCode, riderId);
        else {
          const pod =
            await sql`SELECT 1 FROM delivery_pod_media d JOIN private_media m ON m.id=d.media_id WHERE d.media_id=${input.podMediaId}::uuid AND d.task_id=${task.id}::uuid AND d.rider_id=${riderId}::uuid AND m.owner_id=${riderId}::uuid AND m.purpose='DELIVERY_POD' AND m.state='STORED'`.execute(
              tx,
            );
          if (!pod.rows.length) throw new Error('MEDIA_NOT_FOUND');
        }
        if (order.payment_method === 'COD') {
          const collection = await sql<{
            state: string;
            amount_paise: string;
          }>`SELECT state,amount_paise::text AS "amount_paise" FROM cod_collections WHERE order_id=${task.order_id}::uuid FOR UPDATE`.execute(
            tx,
          );
          const cod = collection.rows[0];
          if (!cod || cod.state !== 'COLLECTED') throw new Error('COD_NOT_COLLECTED');
          if (cod.amount_paise !== order.amount_due_paise) {
            // The discrepancy record must survive the rolled-back delivery.
            throw new CodMismatchError(task.order_id, order.amount_due_paise, cod.amount_paise);
          }
        }
        await this.orderDelivery.markDelivered(task.order_id, riderId, tx);
        transitionTask(task.status, 'DELIVERED');
        const now = await databaseTimeAfterLock(tx);
        const summary = await this.orderReads.orderSummary(task.order_id);
        const distance = await this.distanceForTask(tx, task, summary);
        await sql`UPDATE delivery_tasks SET status='DELIVERED',delivered_at=${now.toISOString()}::timestamptz,distance_metres=${distance},pod_media_id=${input.podMediaId ?? null}::uuid,version=version+1 WHERE id=${task.id}::uuid`.execute(
          tx,
        );
        await taskHistory(tx, task.id, task.status, 'DELIVERED', riderId, 'delivered');
        await taskEvent(
          tx,
          task.id,
          task.order_id,
          'delivery.completed',
          { riderId, podMediaId: input.podMediaId ?? null, contactless: !input.deliveryCode },
          ['notifications'],
        );
        await this.emitOrderDelivered(tx, task, riderId);
        if (distance !== null)
          await this.earnings.recordForTask(
            {
              taskId: task.id,
              orderId: task.order_id,
              riderId,
              distanceMetres: distance,
              detentionMinutes: this.detentionMinutes(task),
              tipPaise: summary?.tipPaise ?? '0',
            },
            tx,
          );
        await releaseRiderTask(tx, riderId, now);
        const effects: Effect[] = [];
        this.emitTaskStatus({ ...task, status: 'DELIVERED' }, effects);
        return { result: task.id, effects };
      });
      return this.finalView(id);
    }
  }

  /** Idempotent discrepancy record committed outside the failed delivery. */
  private async recordCodMismatch(
    orderId: string,
    expectedPaise: string,
    collectedPaise: string,
  ): Promise<void> {
    await transactionWithRetry(this.db, async (tx) => {
      await sql`INSERT INTO cod_mismatches(id,order_id,expected_paise,collected_paise)
        VALUES(${uuidV7()}::uuid,${orderId}::uuid,${expectedPaise},${collectedPaise})
        ON CONFLICT (order_id) DO NOTHING`.execute(tx);
    });
  }

  async fail(
    riderId: string,
    taskId: string,
    input: FailInput,
    reference: string,
  ): Promise<DeliveryTaskView> {
    assertOperationReference(reference);
    assertFailReason(input.reason);
    const id = await this.run(async (tx) => {
      const { task } = await this.requireOwnTask(tx, riderId, taskId);
      if (!(await operation(tx, `fail:${reference}`, 'FAIL_TASK', { taskId, input })))
        return { result: taskId };
      const now = await databaseTimeAfterLock(tx);
      if (!failEndsCustody(task.status)) {
        // Pre-pickup drop: release custody, re-dispatch with attempt_no+1 (D21).
        transitionTask(task.status, 'UNASSIGNED');
        await sql`UPDATE delivery_tasks SET status='UNASSIGNED',rider_id=NULL,attempt_no=attempt_no+1,next_dispatch_at=clock_timestamp(),version=version+1 WHERE id=${task.id}::uuid`.execute(
          tx,
        );
        await taskHistory(
          tx,
          task.id,
          task.status,
          'UNASSIGNED',
          riderId,
          `rider dropped: ${input.reason}`,
        );
        await assignmentHistory(
          tx,
          task.id,
          task.attempt_no,
          riderId,
          'UNASSIGNED',
          riderId,
          input.reason,
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
            reason: input.reason,
          },
          ['notifications'],
        );
        await releaseRiderTask(tx, riderId, now);
        return { result: task.id, effects: [() => void this.dispatchNext(task.order_id)] };
      }
      if (
        ![
          'CUSTOMER_UNREACHABLE',
          'WRONG_ADDRESS',
          'PACKAGE_DAMAGED',
          'VEHICLE_BREAKDOWN',
          'COD_REFUSED',
        ].includes(input.reason)
      )
        throw new Error('INVALID_INPUT');
      if (input.reason === 'WRONG_ADDRESS') throw new Error('ADMIN_RESOLUTION_REQUIRED');
      if (input.reason === 'COD_REFUSED') {
        const order =
          await sql`SELECT 1 FROM orders WHERE id=${task.order_id}::uuid AND payment_method='COD'`.execute(
            tx,
          );
        if (!order.rows.length) throw new Error('INVALID_INPUT');
      }
      if (input.reason === 'CUSTOMER_UNREACHABLE') {
        await assertCustomerFailureReady(tx, task, riderId, now, this.settings);
      }
      transitionTask(task.status, 'FAILED');
      await this.orderDelivery.markDeliveryFailed(
        task.order_id,
        riderId,
        input.reason,
        input.evidence,
        tx,
      );
      await sql`UPDATE delivery_tasks SET status='FAILED',failure_reason=${input.reason},failure_evidence=${input.evidence ? JSON.stringify(input.evidence) : null}::jsonb,version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, task.id, task.status, 'FAILED', riderId, input.reason);
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'delivery.failed',
        { riderId, reason: input.reason, custodyPreserved: true },
        ['notifications'],
      );
      const effects: Effect[] = [];
      this.emitTaskStatus({ ...task, status: 'FAILED' }, effects);
      return { result: task.id, effects };
    });
    return this.finalView(id);
  }

  async contact(riderId: string, taskId: string): Promise<ContactView | null> {
    const rows = await sql<{
      order_id: string;
      status: TaskRow['status'];
      rider_id: string | null;
    }>`SELECT order_id,status,rider_id FROM delivery_tasks WHERE id=${taskId}::uuid`.execute(
      this.db,
    );
    const task = rows.rows[0];
    if (!task) throw new Error('RESOURCE_NOT_FOUND');
    // Terminal rows clear the custody rider; contact stays hidden either way.
    if (task.rider_id !== riderId) throw new Error('RESOURCE_NOT_FOUND');
    if (!contactVisible(task.status)) return null; // hidden outside the custody window
    const summary = await this.orderReads.orderSummary(task.order_id);
    const contact = summary?.addressSnapshot;
    if (!contact?.contactName || !contact?.contactPhone) return null;
    return { contactName: contact.contactName, contactPhone: contact.contactPhone };
  }

  async recordContactAttempt(
    riderId: string,
    taskId: string,
    reference: string,
  ): Promise<{ recordedAt: string }> {
    assertOperationReference(reference);
    return this.run(async (tx) => {
      const { task } = await this.requireOwnTask(tx, riderId, taskId);
      const existing = await sql<{
        attempted_at: Date;
      }>`SELECT attempted_at FROM delivery_contact_attempts
        WHERE task_id=${taskId}::uuid AND rider_id=${riderId}::uuid AND reference=${reference}`.execute(
        tx,
      );
      if (existing.rows[0])
        return { result: { recordedAt: existing.rows[0].attempted_at.toISOString() } };
      if (task.status !== 'ARRIVED' || !task.arrived_customer_at)
        throw new Error('TASK_STATE_INVALID');
      const now = await databaseTimeAfterLock(tx);
      await sql`INSERT INTO delivery_contact_attempts(id,task_id,rider_id,attempt_no,reference,attempted_at)
        VALUES(${uuidV7()}::uuid,${task.id}::uuid,${riderId}::uuid,${task.attempt_no},${reference},${now.toISOString()}::timestamptz)`.execute(
        tx,
      );
      return { result: { recordedAt: now.toISOString() } };
    });
  }

  async codCollect(
    riderId: string,
    taskId: string,
    input: { amountPaise: string },
    reference: string,
  ): Promise<{
    orderId: string;
    collectedPaise: string;
    expectedPaise: string | null;
    mismatch: boolean;
  }> {
    assertOperationReference(reference);
    return this.run(async (tx) => {
      const { task, order } = await this.requireOwnTask(tx, riderId, taskId);
      if (!(await operation(tx, `cod-collect:${reference}`, 'COD_COLLECT', { taskId, input }))) {
        const stored = await sql<{
          result: {
            orderId: string;
            collectedPaise: string;
            expectedPaise: string | null;
            mismatch: boolean;
          } | null;
        }>`
          SELECT result FROM dispatch_operations WHERE reference=${`cod-collect:${reference}`}`.execute(
          tx,
        );
        if (stored.rows[0]?.result) return { result: stored.rows[0].result };
        return {
          result: {
            orderId: task.order_id,
            collectedPaise: input.amountPaise,
            expectedPaise: order.amount_due_paise,
            mismatch: input.amountPaise !== order.amount_due_paise,
          },
        };
      }
      if (!['PICKED_UP', 'ARRIVED'].includes(task.status)) throw new Error('TASK_STATE_INVALID');
      if (order.payment_method !== 'COD') throw new Error('COD_NOT_APPLICABLE');
      const result = await this.cod.collect(
        { orderId: task.order_id, riderId, amountPaise: input.amountPaise },
        tx,
      );
      await sql`UPDATE dispatch_operations SET result=${JSON.stringify({ orderId: task.order_id, collectedPaise: input.amountPaise, expectedPaise: result.expectedPaise, mismatch: result.mismatch })}::jsonb
        WHERE reference=${`cod-collect:${reference}`}`.execute(tx);
      return {
        result: {
          orderId: task.order_id,
          collectedPaise: input.amountPaise,
          expectedPaise: result.expectedPaise,
          mismatch: result.mismatch,
        },
      };
    });
  }

  private detentionMinutes(task: TaskRow): number {
    if (!task.arrived_store_at || !task.pickup_at) return 0;
    return Math.max(
      0,
      Math.round((task.pickup_at.getTime() - task.arrived_store_at.getTime()) / 60000),
    );
  }

  private async distanceForTask(
    tx: TransactionContext,
    task: TaskRow,
    summary: Awaited<ReturnType<OrderDeliveryReads['orderSummary']>> | null,
  ): Promise<number | null> {
    const destination = summary?.addressSnapshot;
    if (!destination || destination.lat === undefined || destination.lng === undefined) return null;
    const store = await this.storePoint(tx, task.store_id);
    if (!store) return null;
    return haversineMetres(store, { lat: destination.lat, lng: destination.lng });
  }

  /** Stores the ETA range and emits eta.updated post-commit (anti-jitter). */
  private async publishEta(
    tx: TransactionContext,
    task: TaskRow,
    effects: Effect[],
    pickedUp: boolean,
  ): Promise<void> {
    const summary = await this.orderReads.orderSummary(task.order_id);
    const destination = summary?.addressSnapshot;
    if (!destination || destination.lat === undefined || destination.lng === undefined) return;
    const store = await this.storePoint(tx, task.store_id);
    if (!store) return;
    const range = await this.eta.eta({
      storeToCustomerMetres: haversineMetres(store, { lat: destination.lat, lng: destination.lng }),
      pickedUp,
    });
    await sql`UPDATE delivery_tasks SET eta_min_minutes=${range.minMinutes},eta_max_minutes=${range.maxMinutes},eta_updated_at=clock_timestamp() WHERE id=${task.id}::uuid`.execute(
      tx,
    );
    effects.push(() =>
      this.broadcasts.emitOrderEvent(task.order_id, 'eta.updated', {
        taskId: task.id,
        minMinutes: range.minMinutes,
        maxMinutes: range.maxMinutes,
      }),
    );
  }

  /** Task-scoped ORDER_DELIVERED; P6 owns the order-aggregate lifecycle. */
  private async emitOrderDelivered(
    tx: TransactionContext,
    task: TaskRow,
    riderId: string,
  ): Promise<void> {
    await taskEvent(
      tx,
      task.id,
      task.order_id,
      'ORDER_DELIVERED',
      { orderId: task.order_id, riderId },
      ['invoicing', 'notifications'],
    );
  }

  private async orderIdOf(taskId: string): Promise<string> {
    const rows = await sql<{
      order_id: string;
    }>`SELECT order_id FROM delivery_tasks WHERE id=${taskId}::uuid`.execute(this.db);
    if (!rows.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    return rows.rows[0].order_id;
  }
}
