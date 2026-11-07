import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { CatalogLookup } from '../../catalog/contracts/lookup.js';
import type { InventorySubstitutionSwaps } from '../../inventory/contracts/substitution.js';
import type { InventoryReservations } from '../../inventory/contracts/inventory.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AdminConfig } from '../../app-config/contracts/config.js';
import type { FinancialAdjustments, OrderCancellation } from '../contracts/fulfillment.js';
import type {
  PickItemInput,
  PickTaskView,
  ShortInput,
  SubstitutionInput,
} from '../contracts/tasks.js';
import {
  assertPickedQuantity,
  assertShortReason,
  canComplete,
  pickQuantity,
  shortQuantity,
  transitionItem,
  transitionTask,
} from '../domain/policy.js';
import { assertSubstitutionAllowed } from '../domain/substitution.js';
import {
  loadItems,
  loadTask,
  mapTask,
  operation,
  taskEvent,
  taskHistory,
} from './pick-primitives.js';

type ItemRow = Awaited<ReturnType<typeof loadItems>>[number];

/**
 * Item-level picking actions and completion. Completion consumes fulfilled
 * stock through inventory contracts, settles shorts through the P6 financial
 * adjustment contract and transitions the task. Unbound P6 dependencies fail
 * closed (typed error, transaction rollback) instead of bypassing money rules.
 */
export class PostgresPickActions {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly admin: AdminConfig,
    private readonly lookup: CatalogLookup,
    private readonly swaps: InventorySubstitutionSwaps,
    private readonly reservations: InventoryReservations,
    private readonly adjustments: FinancialAdjustments,
    private readonly cancellation: OrderCancellation,
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  private async guard(tx: TransactionContext, actorId: string, taskId: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`picking-task:${taskId}`},0))`.execute(
      tx,
    );
    const task = await loadTask(tx, taskId, true);
    if (!task) throw new Error('RESOURCE_NOT_FOUND');
    if (
      !(await this.identity.hasStoreRole(actorId, task.store_id, ['PICKER', 'STORE_MANAGER'], tx))
    )
      throw new Error('RESOURCE_NOT_FOUND');
    if (task.status !== 'IN_PROGRESS' || task.assigned_to !== actorId)
      throw new Error(task.assigned_to === actorId ? 'PICK_TASK_STATE_INVALID' : 'NOT_TASK_OWNER');
    const items = await loadItems(tx, [taskId], true);
    const item = (id: string) => items.find((row) => row.id === id) ?? null;
    return { task, items, item };
  }
  private async view(tx: TransactionContext, taskId: string): Promise<PickTaskView> {
    const task = await loadTask(tx, taskId, false);
    const items = await loadItems(tx, [taskId]);
    return mapTask(task!, items);
  }
  private async assertBatch(
    tx: TransactionContext,
    orderId: string,
    storeId: string,
    variantId: string,
    batchId: string | undefined,
  ): Promise<string | null> {
    const allocations = await sql<{
      batch_id: string;
    }>`SELECT batch_id FROM inventory_allocations WHERE order_id=${orderId}::uuid AND store_id=${storeId}::uuid AND variant_id=${variantId}::uuid`.execute(
      tx,
    );
    if (!allocations.rows.length) {
      if (batchId) throw new Error('INVALID_BATCH');
      return null;
    }
    if (!batchId) throw new Error('BATCH_REQUIRED');
    if (!allocations.rows.some((row) => row.batch_id === batchId)) throw new Error('INVALID_BATCH');
    return batchId;
  }

  async pickItem(
    actorId: string,
    taskId: string,
    itemId: string,
    input: PickItemInput,
    reference: string,
  ): Promise<PickTaskView> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    const qty = pickQuantity(input.quantity);
    return this.run(undefined, async (tx) => {
      const { task, item } = await this.guard(tx, actorId, taskId);
      const row = item(itemId);
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.status === 'SHORT' || row.status === 'SUBSTITUTED')
        throw new Error('ITEM_ALREADY_RESOLVED');
      if (
        !(await operation(tx, `pick:${taskId}:${itemId}:${reference}`, 'PICK', {
          taskId,
          itemId,
          input,
        }))
      )
        return this.view(tx, taskId);
      const scanned = await this.lookup.variantByBarcode(task.store_id, input.scannedBarcode);
      if (!scanned || scanned.variantId !== row.variant_id) throw new Error('WRONG_ITEM');
      assertPickedQuantity(BigInt(row.expected_qty), qty);
      const batchId = await this.assertBatch(
        tx,
        task.order_id,
        task.store_id,
        row.variant_id,
        input.batchId,
      );
      const next = transitionItem(row.status, 'PICKED');
      await sql`UPDATE pick_items SET status=${next},picked_qty=${qty.toString()}::bigint,batch_id=${batchId} WHERE id=${itemId}::uuid AND task_id=${taskId}::uuid`.execute(
        tx,
      );
      return this.view(tx, taskId);
    });
  }

  async shortItem(
    actorId: string,
    taskId: string,
    itemId: string,
    input: ShortInput,
    reference: string,
  ): Promise<PickTaskView> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    assertShortReason(input.reason);
    return this.run(undefined, async (tx) => {
      const { item } = await this.guard(tx, actorId, taskId);
      const row = item(itemId);
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.status === 'SUBSTITUTED') throw new Error('ITEM_ALREADY_RESOLVED');
      if (
        !(await operation(tx, `short:${taskId}:${itemId}:${reference}`, 'SHORT', {
          taskId,
          itemId,
          reason: input.reason,
        }))
      )
        return this.view(tx, taskId);
      shortQuantity(BigInt(row.expected_qty), BigInt(row.picked_qty));
      const next = transitionItem(row.status, 'SHORT');
      await sql`UPDATE pick_items SET status=${next},short_reason=${input.reason} WHERE id=${itemId}::uuid AND task_id=${taskId}::uuid`.execute(
        tx,
      );
      return this.view(tx, taskId);
    });
  }

  async substituteItem(
    actorId: string,
    taskId: string,
    itemId: string,
    input: SubstitutionInput,
    reference: string,
  ): Promise<PickTaskView> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    return this.run(undefined, async (tx) => {
      const { task, item } = await this.guard(tx, actorId, taskId);
      const row = item(itemId);
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.status !== 'PENDING')
        throw new Error(
          row.status === 'SUBSTITUTED' ? 'ITEM_ALREADY_RESOLVED' : 'SUBSTITUTION_STATE_INVALID',
        );
      if (
        !(await operation(tx, `sub:${taskId}:${itemId}:${reference}`, 'SUBSTITUTE', {
          taskId,
          itemId,
          input,
        }))
      )
        return this.view(tx, taskId);
      const { flags } = await this.admin.snapshot();
      const candidates = await sql<{
        candidate_variant_id: string;
      }>`SELECT candidate_variant_id FROM substitute_candidates WHERE variant_id=${row.variant_id}::uuid`.execute(
        tx,
      );
      assertSubstitutionAllowed(
        flags.auto_substitution,
        row.variant_id,
        input.candidateVariantId,
        candidates.rows.map((c) => ({
          variantId: row.variant_id,
          candidateVariantId: c.candidate_variant_id,
        })),
      );
      const scanned = await this.lookup.variantByBarcode(task.store_id, input.scannedBarcode);
      if (!scanned || scanned.variantId !== input.candidateVariantId) throw new Error('WRONG_ITEM');
      const target = await sql<{
        target_delivery_at: Date;
      }>`SELECT target_delivery_at FROM inventory_reservations WHERE order_id=${task.order_id}::uuid AND store_id=${task.store_id}::uuid AND variant_id=${row.variant_id}::uuid`.execute(
        tx,
      );
      if (!target.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      await this.swaps.swap(
        {
          orderId: task.order_id,
          storeId: task.store_id,
          releaseVariantId: row.variant_id,
          acquireVariantId: input.candidateVariantId,
          quantity: row.expected_qty,
          targetDeliveryAt: target.rows[0].target_delivery_at.toISOString(),
          reference: `${taskId}:${itemId}:${reference}`,
        },
        tx,
      );
      const batchId = await this.assertBatch(
        tx,
        task.order_id,
        task.store_id,
        input.candidateVariantId,
        input.batchId,
      );
      const next = transitionItem(row.status, 'SUBSTITUTED');
      await sql`UPDATE pick_items SET status=${next},substitute_variant_id=${input.candidateVariantId}::uuid,picked_qty=${row.expected_qty}::bigint,batch_id=${batchId} WHERE id=${itemId}::uuid AND task_id=${taskId}::uuid`.execute(
        tx,
      );
      return this.view(tx, taskId);
    });
  }

  async complete(actorId: string, taskId: string, reference: string): Promise<PickTaskView> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    return this.run(undefined, async (tx) => {
      const { task, items } = await this.guard(tx, actorId, taskId);
      if (!(await operation(tx, `complete:${taskId}:${reference}`, 'COMPLETE', { taskId })))
        return this.view(tx, taskId);
      if (!canComplete(items)) throw new Error('PICK_TASK_INCOMPLETE');
      const rows = items as ItemRow[];
      const allShort = rows.every((item) => item.status === 'SHORT') && rows.length > 0;
      // All-short orders go through the shared order cancel routine (P6), which
      // compensates the order and cancels this task through PICK_CANCELLATION.
      if (allShort) {
        await this.cancellation.systemCancel(task.order_id, 'ALL_ITEMS_SHORT', tx);
        return this.view(tx, taskId);
      }
      // One aggregated pick line per resolved variant; shorts carry zero and release.
      const lines = new Map<string, { storeId: string; variantId: string; quantity: bigint }>();
      for (const item of rows) {
        const variantId =
          item.status === 'SUBSTITUTED' ? item.substitute_variant_id! : item.variant_id;
        const picked = item.status === 'SHORT' ? 0n : BigInt(item.picked_qty);
        const existing = lines.get(variantId);
        lines.set(variantId, {
          storeId: task.store_id,
          variantId,
          quantity: (existing?.quantity ?? 0n) + picked,
        });
      }
      await this.reservations.pick(
        task.order_id,
        [...lines.values()].map((line) => ({ ...line, quantity: line.quantity.toString() })),
        tx,
      );
      const adjustmentLines = rows.flatMap((item) => {
        if (item.status === 'SHORT')
          return [
            {
              orderItemId: item.order_item_id,
              shortQty: shortQuantity(
                BigInt(item.expected_qty),
                BigInt(item.picked_qty),
              ).toString(),
              reason: item.short_reason!,
            },
          ];
        if (item.status === 'SUBSTITUTED')
          return [
            {
              orderItemId: item.order_item_id,
              shortQty: '0',
              reason: 'SUBSTITUTED',
              substituteVariantId: item.substitute_variant_id!,
            },
          ];
        return [];
      });
      if (adjustmentLines.length)
        await this.adjustments.recordShort({
          orderId: task.order_id,
          actorId,
          lines: adjustmentLines,
          tx,
        });
      const now = await databaseTimeAfterLock(tx);
      transitionTask(task.status, 'COMPLETED');
      await sql`UPDATE pick_tasks SET status='COMPLETED',completed_at=${now.toISOString()}::timestamptz,completed_by=${actorId}::uuid,version=version+1 WHERE id=${taskId}::uuid`.execute(
        tx,
      );
      await taskHistory(tx, taskId, task.status, 'COMPLETED', actorId);
      await taskEvent(
        tx,
        taskId,
        task.order_id,
        'picking.task_completed',
        {
          completedAt: now.toISOString(),
        },
        ['dispatch', 'notifications'],
      );
      return this.view(tx, taskId);
    });
  }
}
