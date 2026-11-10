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
  withinWeightTolerance,
} from '../domain/policy.js';
import { assertSubstitutionAllowed } from '../domain/substitution.js';
import {
  itemEvent,
  loadItems,
  loadTask,
  mapTask,
  operation,
  taskEvent,
  taskHistory,
} from './pick-primitives.js';
import { PostgresPickCancellation } from './postgres-pick-cancellation.js';

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
    const target = await sql<{
      order_id: string;
      store_id: string;
    }>`SELECT order_id,store_id FROM pick_tasks WHERE id=${taskId}::uuid`.execute(tx);
    if (!target.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    const order = await sql<{
      on_hold: boolean;
    }>`SELECT on_hold FROM orders WHERE id=${target.rows[0].order_id}::uuid FOR UPDATE`.execute(tx);
    if (order.rows[0]?.on_hold) throw new Error('ORDER_ON_HOLD');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-order:${target.rows[0].order_id}`},0))`.execute(
      tx,
    );
    await sql`SELECT store_id FROM store_inventory WHERE store_id=${target.rows[0].store_id}::uuid
      AND variant_id IN (SELECT variant_id FROM pick_items WHERE task_id=${taskId}::uuid UNION
        SELECT substitute_variant_id FROM pick_items WHERE task_id=${taskId}::uuid AND substitute_variant_id IS NOT NULL)
      ORDER BY store_id,variant_id FOR UPDATE`.execute(tx);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`picking-task:${taskId}`},0))`.execute(
      tx,
    );
    const task = await loadTask(tx, taskId, true);
    if (!task) throw new Error('RESOURCE_NOT_FOUND');
    if (
      !(await this.identity.hasStoreRole(actorId, task.store_id, ['PICKER', 'STORE_MANAGER'], tx))
    )
      throw new Error('RESOURCE_NOT_FOUND');
    const items = await loadItems(tx, [taskId], true);
    const item = (id: string) => items.find((row) => row.id === id) ?? null;
    if (task.assigned_to === actorId)
      await sql`UPDATE pick_tasks SET last_activity_at=clock_timestamp() WHERE id=${taskId}::uuid`.execute(
        tx,
      );
    return { task, items, item };
  }
  private active(task: { status: string; assigned_to: string | null }, actorId: string): void {
    if (task.status !== 'IN_PROGRESS' || task.assigned_to !== actorId)
      throw new Error(task.assigned_to === actorId ? 'PICK_TASK_STATE_INVALID' : 'NOT_TASK_OWNER');
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
    amount = 0n,
  ): Promise<string | null> {
    const allocations = await sql<{
      batch_id: string;
      quantity: string;
      eligible: boolean;
    }>`SELECT a.batch_id,a.quantity::text,b.state='ACTIVE' AND (b.expires_at IS NULL OR b.expires_at>
      GREATEST(clock_timestamp(),r.target_delivery_at)+COALESCE(s.min_seconds,0)*interval '1 second') AS eligible
      FROM inventory_allocations a JOIN inventory_batches b ON b.id=a.batch_id
      JOIN inventory_reservations r ON r.order_id=a.order_id AND r.store_id=a.store_id AND r.variant_id=a.variant_id JOIN catalog_variants v ON v.id=a.variant_id
      JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id
      WHERE a.order_id=${orderId}::uuid AND a.store_id=${storeId}::uuid AND a.variant_id=${variantId}::uuid`.execute(
      tx,
    );
    if (!allocations.rows.length) {
      throw new Error('INVALID_BATCH');
    }
    if (!batchId) {
      const first = allocations.rows.find((row) => row.eligible && BigInt(row.quantity) >= amount);
      if (!first) throw new Error('BATCH_REQUIRED');
      batchId = first.batch_id;
    }
    const allocation = allocations.rows.find((row) => row.batch_id === batchId);
    if (!allocation || !allocation.eligible || BigInt(allocation.quantity) < amount)
      throw new Error('INVALID_BATCH');
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
      if (
        !(await operation(tx, `pick:${taskId}:${itemId}:${reference}`, 'PICK', {
          taskId,
          itemId,
          input,
        }))
      )
        return this.view(tx, taskId);
      this.active(task, actorId);
      if (row.status === 'SHORT' || row.status === 'SUBSTITUTED')
        throw new Error('ITEM_ALREADY_RESOLVED');
      const scanned = await this.lookup.variantByBarcode(task.store_id, input.scannedBarcode);
      if (!scanned || scanned.variantId !== row.variant_id) throw new Error('WRONG_ITEM');
      assertPickedQuantity(BigInt(row.expected_qty), qty);
      const batches =
        input.batches ??
        (input.batchId ? [{ batchId: input.batchId, quantity: input.quantity }] : []);
      if (!batches.length) throw new Error('BATCH_REQUIRED');
      if (
        !batches.length ||
        batches.length > 20 ||
        new Set(batches.map((b) => b.batchId)).size !== batches.length ||
        batches.reduce((sum, b) => sum + pickQuantity(b.quantity), 0n) !== qty
      )
        throw new Error('INVALID_BATCH');
      for (const batch of batches)
        await this.assertBatch(
          tx,
          task.order_id,
          task.store_id,
          row.variant_id,
          batch.batchId,
          pickQuantity(batch.quantity),
        );
      const batchId = batches[0]!.batchId;
      await sql`DELETE FROM pick_item_batches WHERE item_id=${itemId}::uuid`.execute(tx);
      for (const batch of batches)
        await sql`INSERT INTO pick_item_batches(item_id,batch_id,quantity)
        VALUES(${itemId}::uuid,${batch.batchId}::uuid,${batch.quantity}::bigint)`.execute(tx);
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
      const { task, item } = await this.guard(tx, actorId, taskId);
      const row = item(itemId);
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (
        !(await operation(tx, `short:${taskId}:${itemId}:${reference}`, 'SHORT', {
          taskId,
          itemId,
          reason: input.reason,
        }))
      )
        return this.view(tx, taskId);
      this.active(task, actorId);
      if (row.status === 'SUBSTITUTED') throw new Error('ITEM_ALREADY_RESOLVED');
      if (row.status === 'SHORT') return this.view(tx, taskId);
      shortQuantity(BigInt(row.expected_qty), BigInt(row.picked_qty));
      const next = transitionItem(row.status, 'SHORT');
      await sql`UPDATE pick_items SET status=${next},short_reason=${input.reason} WHERE id=${itemId}::uuid AND task_id=${taskId}::uuid`.execute(
        tx,
      );
      await itemEvent(tx, taskId, task.order_id, row.order_item_id, row.variant_id, 'SHORT');
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
      if (
        !(await operation(tx, `sub:${taskId}:${itemId}:${reference}`, 'SUBSTITUTE', {
          taskId,
          itemId,
          input,
        }))
      )
        return this.view(tx, taskId);
      this.active(task, actorId);
      if (row.status !== 'PENDING')
        throw new Error(
          row.status === 'SUBSTITUTED' ? 'ITEM_ALREADY_RESOLVED' : 'SUBSTITUTION_STATE_INVALID',
        );
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
        BigInt(row.expected_qty),
      );
      await sql`INSERT INTO pick_item_batches(item_id,batch_id,quantity) VALUES(${itemId}::uuid,${batchId}::uuid,${row.expected_qty}::bigint)`.execute(
        tx,
      );
      const next = transitionItem(row.status, 'SUBSTITUTED');
      await sql`UPDATE pick_items SET status=${next},substitute_variant_id=${input.candidateVariantId}::uuid,picked_qty=${row.expected_qty}::bigint,batch_id=${batchId} WHERE id=${itemId}::uuid AND task_id=${taskId}::uuid`.execute(
        tx,
      );
      await itemEvent(
        tx,
        taskId,
        task.order_id,
        row.order_item_id,
        input.candidateVariantId,
        'SUBSTITUTED',
      );
      return this.view(tx, taskId);
    });
  }

  async complete(actorId: string, taskId: string, reference: string): Promise<PickTaskView> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    return this.run(undefined, async (tx) => {
      const { task, items } = await this.guard(tx, actorId, taskId);
      if (task.status === 'COMPLETED' && task.assigned_to === actorId) return this.view(tx, taskId);
      if (!(await operation(tx, `complete:${taskId}:${reference}`, 'COMPLETE', { taskId })))
        return this.view(tx, taskId);
      this.active(task, actorId);
      if (!canComplete(items)) throw new Error('PICK_TASK_INCOMPLETE');
      const rows = items as ItemRow[];
      const weighted = await sql<{
        id: string;
      }>`SELECT id FROM catalog_variants WHERE base_unit<>'PIECE'
        AND id=ANY(${rows.filter((row) => row.status === 'PICKED').map((row) => row.variant_id)}::uuid[])`.execute(
        tx,
      );
      if (weighted.rows.length) {
        const tolerance = (await this.admin.snapshot()).config.pickingWeightToleranceBps;
        for (const item of rows)
          if (
            weighted.rows.some((row) => row.id === item.variant_id) &&
            !withinWeightTolerance(BigInt(item.expected_qty), BigInt(item.picked_qty), tolerance)
          )
            throw new Error('WEIGHT_TOLERANCE_EXCEEDED');
      }
      const source = await sql<{
        source: string;
      }>`SELECT source FROM orders WHERE id=${task.order_id}::uuid`.execute(tx);
      const subscriptionShort =
        source.rows[0]?.source === 'SUBSCRIPTION' &&
        rows.some((item) => BigInt(item.picked_qty) < BigInt(item.expected_qty));
      if (subscriptionShort) {
        await this.cancellation.systemCancel(task.order_id, 'SUBSCRIPTION_OOS', tx);
        await new PostgresPickCancellation(this.db).cancel(task.order_id, 'SUBSCRIPTION_OOS', tx);
        await sql`UPDATE subscription_occurrences SET fulfillment_outcome='SKIPPED_OOS',updated_at=clock_timestamp() WHERE order_id=${task.order_id}::uuid`.execute(
          tx,
        );
        return this.view(tx, taskId);
      }
      const allShort = rows.length > 0 && rows.every((item) => BigInt(item.picked_qty) === 0n);
      // All-short orders go through the shared order cancel routine (P6), which
      // compensates the order and cancels this task through PICK_CANCELLATION.
      if (allShort) {
        await this.cancellation.systemCancel(task.order_id, 'ALL_ITEMS_SHORT', tx);
        await new PostgresPickCancellation(this.db).cancel(task.order_id, 'ALL_ITEMS_SHORT', tx);
        return this.view(tx, taskId);
      }
      // One aggregated pick line per resolved variant; shorts carry zero and release.
      const lines = new Map<
        string,
        {
          storeId: string;
          variantId: string;
          quantity: bigint;
          batches: { batchId: string; quantity: string }[];
        }
      >();
      const selected = await sql<{
        item_id: string;
        batch_id: string;
        quantity: string;
      }>`SELECT item_id,batch_id,quantity::text
        FROM pick_item_batches WHERE item_id=ANY(${rows.map((row) => row.id)}::uuid[]) ORDER BY item_id,batch_id`.execute(
        tx,
      );
      for (const item of rows) {
        const variantId =
          item.status === 'SUBSTITUTED' ? item.substitute_variant_id! : item.variant_id;
        const picked = BigInt(item.picked_qty);
        const existing = lines.get(variantId);
        lines.set(variantId, {
          storeId: task.store_id,
          variantId,
          quantity: (existing?.quantity ?? 0n) + picked,
          batches: [
            ...(existing?.batches ?? []),
            ...selected.rows
              .filter((batch) => batch.item_id === item.id)
              .map((batch) => ({ batchId: batch.batch_id, quantity: batch.quantity })),
          ],
        });
      }
      await this.reservations.pick(
        task.order_id,
        [...lines.values()].map((line) => {
          const batches = new Map<string, bigint>();
          for (const batch of line.batches)
            batches.set(batch.batchId, (batches.get(batch.batchId) ?? 0n) + BigInt(batch.quantity));
          return {
            ...line,
            quantity: line.quantity.toString(),
            batches: batches.size
              ? [...batches].map(([batchId, quantity]) => ({
                  batchId,
                  quantity: quantity.toString(),
                }))
              : undefined,
          };
        }),
        tx,
      );
      await this.adjustments.settleFulfillment({
        orderId: task.order_id,
        actorId,
        lines: rows.map((item) => ({
          orderItemId: item.order_item_id,
          variantId: item.variant_id,
          fulfilledQty: item.picked_qty,
          shortQty: (BigInt(item.expected_qty) - BigInt(item.picked_qty)).toString(),
          ...(item.short_reason ? { reason: item.short_reason } : {}),
          ...(item.substitute_variant_id
            ? { substituteVariantId: item.substitute_variant_id }
            : {}),
        })),
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
        ['dispatch-trigger', 'notifications'],
      );
      return this.view(tx, taskId);
    });
  }
}
