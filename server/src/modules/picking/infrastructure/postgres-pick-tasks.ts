import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { InventoryPickGuidance } from '../../inventory/contracts/pick-guidance.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { IdentityRoster } from '../../identity/contracts/roster.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { OrderFulfillment, OrderFulfillmentReads } from '../contracts/fulfillment.js';
import type {
  ClaimResult,
  KpiSummary,
  PickTaskPage,
  PickTaskView,
  PickTasks,
  QueueInput,
  SlaTaskPage,
  StoreStaffPage,
} from '../contracts/tasks.js';
import {
  activeTaskCount,
  assertStoreRole,
  decodeCursor,
  encodeCursor,
  loadItems,
  loadTask,
  mapTask,
  operation,
  taskEvent,
  taskHistory,
} from './pick-primitives.js';
import { assertOperationReference, transitionTask } from '../domain/policy.js';
import type { PostgresPickActions } from './postgres-pick-actions.js';
import type { PostgresPickViews } from './postgres-pick-views.js';

/**
 * Task lifecycle facade: queue reads, self-claim, start, manager reassignment
 * and the manager board views. Item actions live in PostgresPickActions and
 * are delegated; both share the transaction discipline (advisory task lock,
 * store-scoped roles, history rows, change events).
 */
export class PostgresPickTasks implements PickTasks {
  async heartbeat(actorId: string, taskId: string): Promise<void> {
    const updated =
      await sql`UPDATE pick_tasks SET last_activity_at=clock_timestamp() WHERE id=${taskId}::uuid
      AND assigned_to=${actorId}::uuid AND status IN ('ASSIGNED','IN_PROGRESS') RETURNING id`.execute(
        this.db,
      );
    if (!updated.rows.length) throw new Error('RESOURCE_NOT_FOUND');
  }
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly config: AppConfig,
    private readonly guidance: InventoryPickGuidance,
    private readonly actions: PostgresPickActions,
    private readonly views: PostgresPickViews,
    private readonly roster: IdentityRoster,
    private readonly reads: OrderFulfillmentReads,
    private readonly fulfillment: OrderFulfillment,
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  private async lockTask(tx: TransactionContext, taskId: string) {
    const projection = await loadTask(tx, taskId, false);
    if (!projection) throw new Error('RESOURCE_NOT_FOUND');
    const order = await sql<{
      on_hold: boolean;
    }>`SELECT on_hold FROM orders WHERE id=${projection.order_id}::uuid FOR UPDATE`.execute(tx);
    if (order.rows[0]?.on_hold) throw new Error('ORDER_ON_HOLD');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`picking-task:${taskId}`},0))`.execute(
      tx,
    );
    const task = await loadTask(tx, taskId, true);
    if (!task || task.order_id !== projection.order_id) throw new Error('RESOURCE_NOT_FOUND');
    return task;
  }
  private async view(tx: TransactionContext, task: Awaited<ReturnType<typeof loadTask>>) {
    const items = await loadItems(tx, [task!.id]);
    const pending = items.filter((item) => item.status === 'PENDING');
    let suggestions = new Map<
      string,
      { batchId: string; batchCode: string; expiresAt: string | null; availableQty: string }[]
    >();
    if (pending.length)
      suggestions = await this.guidance.suggest({
        storeId: task!.store_id,
        variantIds: [...new Set(pending.map((item) => item.variant_id))],
        targetDeliveryAt: task!.sla_due_at.toISOString(),
        orderId: task!.order_id,
      });
    const view = mapTask(task!, items);
    for (const item of view.items) item.fefoSuggestions = suggestions.get(item.variantId) ?? [];
    return view;
  }

  async queue(actorId: string, input: QueueInput): Promise<PickTaskPage> {
    const limit = input.limit ?? 20;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !['QUEUE', 'MINE', 'ALL'].includes(input.scope)
    )
      throw new Error('INVALID_INPUT');
    return this.run(undefined, async (tx) => {
      await assertStoreRole(this.identity, actorId, input.storeId, ['STORE_MANAGER'], tx);
      if (input.scope === 'ALL')
        await assertStoreRole(this.identity, actorId, input.storeId, ['STORE_MANAGER'], tx);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (input.cursor && !cursor) throw new Error('INVALID_CURSOR');
      const filter =
        input.scope === 'QUEUE'
          ? sql`status='PENDING'`
          : input.scope === 'MINE'
            ? sql`assigned_to=${actorId}::uuid AND status IN ('ASSIGNED','IN_PROGRESS')`
            : sql`status NOT IN ('COMPLETED','CANCELLED')`;
      const rows = await sql<{
        id: string;
      }>`SELECT id FROM pick_tasks WHERE store_id=${input.storeId}::uuid AND available_at <= clock_timestamp() AND ${filter} AND (${cursor ? sql`(sla_due_at,id) > (${cursor.slaDueAt}::timestamptz,${cursor.id}::uuid)` : sql`true`}) ORDER BY sla_due_at,id LIMIT ${limit + 1}`.execute(
        tx,
      );
      const page = rows.rows.slice(0, limit);
      const items = await loadItems(
        tx,
        page.map((row) => row.id),
      );
      const pendingByTask = new Map<string, string[]>();
      for (const item of items)
        if (item.status === 'PENDING')
          pendingByTask.set(item.task_id, [
            ...(pendingByTask.get(item.task_id) ?? []),
            item.variant_id,
          ]);
      const suggestionsByTask = new Map<
        string,
        Map<
          string,
          { batchId: string; batchCode: string; expiresAt: string | null; availableQty: string }[]
        >
      >();
      for (const [taskId, variantIds] of pendingByTask) {
        const task = await loadTask(tx, taskId, false);
        if (!task) continue;
        suggestionsByTask.set(
          taskId,
          await this.guidance.suggest({
            storeId: task.store_id,
            variantIds: [...new Set(variantIds)],
            targetDeliveryAt: task.sla_due_at.toISOString(),
            orderId: task.order_id,
          }),
        );
      }
      const tasks: PickTaskView[] = [];
      for (const row of page) {
        const task = await loadTask(tx, row.id, false);
        if (!task) continue;
        const view = mapTask(task, items);
        const suggestions = suggestionsByTask.get(task.id);
        if (suggestions)
          for (const item of view.items)
            item.fefoSuggestions = suggestions.get(item.variantId) ?? [];
        tasks.push(view);
      }
      const last = page.at(-1);
      const full = last ? (await loadTask(tx, last.id, false))! : null;
      return {
        items: tasks,
        nextCursor: rows.rows.length > limit && full ? encodeCursor(full) : null,
      };
    });
  }

  async claim(actorId: string, taskId: string, reference: string): Promise<ClaimResult> {
    assertOperationReference(reference);
    return this.run(undefined, async (tx) => {
      const task = await this.lockTask(tx, taskId);
      await assertStoreRole(this.identity, actorId, task.store_id, ['STORE_MANAGER'], tx);
      const availability = await sql<{
        ready: boolean;
      }>`SELECT available_at <= clock_timestamp() AS ready FROM pick_tasks WHERE id=${taskId}::uuid`.execute(
        tx,
      );
      if (!availability.rows[0]?.ready) throw new Error('PICK_TASK_NOT_AVAILABLE');
      if (task.status === 'ASSIGNED' && task.assigned_to === actorId)
        return { task: await this.view(tx, task) };
      if (task.status !== 'PENDING') throw new Error('PICK_TASK_STATE_INVALID');
      if (!(await operation(tx, `claim:${taskId}:${reference}`, 'CLAIM', { taskId, actorId })))
        return { task: await this.view(tx, task) };
      const cap = await this.config.get('maxActivePickTasksPerPicker');
      if ((await activeTaskCount(tx, actorId)) >= cap) throw new Error('PICKER_AT_CAPACITY');
      transitionTask(task.status, 'ASSIGNED');
      await sql`UPDATE pick_tasks SET last_activity_at=clock_timestamp(),status='ASSIGNED',assigned_to=${actorId}::uuid,version=version+1 WHERE id=${taskId}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, taskId, task.status, 'ASSIGNED', actorId);
      await taskEvent(
        tx,
        taskId,
        task.order_id,
        'picking.task_changed',
        {
          previous: task.status,
          status: 'ASSIGNED',
          assignedTo: actorId,
        },
        ['dispatch-trigger', 'notifications'],
      );
      return { task: await this.view(tx, await loadTask(tx, taskId, false)) };
    });
  }

  async start(actorId: string, taskId: string, reference: string): Promise<PickTaskView> {
    assertOperationReference(reference);
    return this.run(undefined, async (tx) => {
      const task = await this.lockTask(tx, taskId);
      await assertStoreRole(this.identity, actorId, task.store_id, ['STORE_MANAGER'], tx);
      const availability = await sql<{
        ready: boolean;
      }>`SELECT available_at <= clock_timestamp() AS ready FROM pick_tasks WHERE id=${taskId}::uuid`.execute(
        tx,
      );
      if (!availability.rows[0]?.ready) throw new Error('PICK_TASK_NOT_AVAILABLE');
      if (task.status === 'IN_PROGRESS' && task.assigned_to === actorId) return this.view(tx, task);
      if (task.status !== 'ASSIGNED' || task.assigned_to !== actorId)
        throw new Error(
          task.status === 'IN_PROGRESS' ? 'NOT_TASK_OWNER' : 'PICK_TASK_STATE_INVALID',
        );
      if (!(await operation(tx, `start:${taskId}:${reference}`, 'START', { taskId })))
        return this.view(tx, task);
      const now = await databaseTimeAfterLock(tx);
      await sql`UPDATE pick_tasks SET last_activity_at=clock_timestamp(),status='IN_PROGRESS',started_at=${now.toISOString()}::timestamptz,version=version+1 WHERE id=${taskId}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, taskId, task.status, 'IN_PROGRESS', actorId);
      await taskEvent(
        tx,
        taskId,
        task.order_id,
        'picking.task_changed',
        {
          previous: task.status,
          status: 'IN_PROGRESS',
        },
        ['dispatch-trigger', 'notifications'],
      );
      // The order state machine (P6) moves CONFIRMED→PICKING in this transaction.
      await this.fulfillment.startPicking(task.order_id, actorId, tx);
      return this.view(tx, await loadTask(tx, taskId, false));
    });
  }

  async reassign(
    actorId: string,
    taskId: string,
    toUserId: string,
    reason: string,
    reference: string,
  ): Promise<PickTaskView> {
    assertOperationReference(reference);
    if (!reason || reason.length > 300) throw new Error('INVALID_INPUT');
    return this.run(undefined, async (tx) => {
      const task = await this.lockTask(tx, taskId);
      await assertStoreRole(this.identity, actorId, task.store_id, ['STORE_MANAGER'], tx);
      if (task.status !== 'ASSIGNED' && task.status !== 'IN_PROGRESS')
        throw new Error('PICK_TASK_STATE_INVALID');
      if (task.assigned_to === toUserId) return this.view(tx, task);
      await assertStoreRole(this.identity, toUserId, task.store_id, ['STORE_MANAGER'], tx);
      if (
        !(await operation(tx, `reassign:${taskId}:${reference}`, 'REASSIGN', {
          taskId,
          toUserId,
          reason,
        }))
      )
        return this.view(tx, task);
      const cap = await this.config.get('maxActivePickTasksPerPicker');
      if ((await activeTaskCount(tx, toUserId)) >= cap) throw new Error('PICKER_AT_CAPACITY');
      transitionTask(task.status, 'ASSIGNED');
      await sql`UPDATE pick_tasks SET last_activity_at=clock_timestamp(),status='ASSIGNED',assigned_to=${toUserId}::uuid,started_at=NULL,version=version+1 WHERE id=${taskId}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, taskId, task.status, 'ASSIGNED', actorId, reason);
      await taskEvent(
        tx,
        taskId,
        task.order_id,
        'picking.task_changed',
        {
          previous: task.status,
          status: 'ASSIGNED',
          assignedTo: toUserId,
          reason,
        },
        ['dispatch-trigger', 'notifications'],
      );
      return this.view(tx, await loadTask(tx, taskId, false));
    });
  }

  pickItem(...args: Parameters<PostgresPickActions['pickItem']>) {
    return this.actions.pickItem(...args);
  }
  shortItem(...args: Parameters<PostgresPickActions['shortItem']>) {
    return this.actions.shortItem(...args);
  }
  substituteItem(...args: Parameters<PostgresPickActions['substituteItem']>) {
    return this.actions.substituteItem(...args);
  }
  complete(...args: Parameters<PostgresPickActions['complete']>) {
    return this.actions.complete(...args);
  }

  async kpis(actorId: string, storeId: string): Promise<KpiSummary> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    return this.views.kpis(storeId);
  }

  async slaBoard(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<SlaTaskPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    return this.views.slaBoard(storeId, cursor, limit ?? 50);
  }

  async staff(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<StoreStaffPage> {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    const page = await this.roster.storeStaff(storeId, cursor, limit ?? 50);
    const counts = await sql<{
      assigned_to: string;
      count: string;
    }>`SELECT assigned_to,count(*)::text AS count FROM pick_tasks WHERE store_id=${storeId}::uuid AND status IN ('ASSIGNED','IN_PROGRESS') AND assigned_to IS NOT NULL GROUP BY assigned_to`.execute(
      this.db,
    );
    const byUser = new Map(counts.rows.map((row) => [row.assigned_to, Number(row.count)]));
    return {
      items: page.items.map((member) => ({
        ...member,
        activeTasks: byUser.get(member.userId) ?? 0,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async storeOrders(actorId: string, storeId: string, cursor?: string, limit?: number) {
    await assertStoreRole(this.identity, actorId, storeId, ['STORE_MANAGER']);
    return this.reads.storeOrders(storeId, cursor, limit ?? 20);
  }
}
