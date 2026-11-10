import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { InventoryReturns, ReturnReceipt } from '../contracts/returns.js';
import { quantity } from '../domain/quantity.js';
import { lockStock, movement, operation } from './stock-primitives.js';
import { stockAlerts } from './alerts.js';
export class PostgresInventoryReturns implements InventoryReturns {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}
  async receiveCancelledOrder(
    orderId: string,
    actorId: string | null,
    tx: TransactionContext,
  ): Promise<void> {
    const order = await sql<{
      store_id: string;
      status: string;
    }>`SELECT store_id,status FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
    if (order.rows[0]?.status !== 'CANCELLED') throw new Error('ILLEGAL_STATE_TRANSITION');
    const custody =
      await sql`SELECT id FROM delivery_tasks WHERE order_id=${orderId}::uuid AND pickup_at IS NOT NULL`.execute(
        tx,
      );
    if (custody.rows.length) throw new Error('ILLEGAL_STATE_TRANSITION');
    const stock = await sql<{
      variant_id: string;
      picked: string;
      returned: string;
      expires_at: Date | null;
    }>`SELECT l.variant_id,(-sum(l.on_hand_delta))::text AS picked,
      COALESCE((SELECT sum(r.quantity) FROM inventory_returns r WHERE r.order_id=${orderId}::uuid AND r.store_id=l.store_id AND r.variant_id=l.variant_id),0)::text AS returned,
      min(b.expires_at) AS expires_at FROM inventory_ledger l JOIN inventory_batches b ON b.id=l.batch_id
      WHERE l.store_id=${order.rows[0].store_id}::uuid AND (l.reference=${`pick:${orderId}`} OR l.reference LIKE ${`pick:${orderId}:g%`})
        AND l.kind='RESERVE_COMMIT_PICK' GROUP BY l.store_id,l.variant_id ORDER BY l.variant_id`.execute(
      tx,
    );
    for (const row of stock.rows) {
      const remaining = BigInt(row.picked) - BigInt(row.returned);
      if (remaining <= 0n) continue;
      await this.receive(
        actorId,
        {
          returnId: uuidV7(),
          orderId,
          storeId: order.rows[0].store_id,
          variantId: row.variant_id,
          quantity: remaining.toString(),
          expiresAt: row.expires_at?.toISOString() ?? null,
        },
        tx,
        true,
      );
    }
  }
  async receiveReturn(
    actor: string,
    input: ReturnReceipt,
    outer?: TransactionContext,
  ): Promise<void> {
    return this.receive(actor, input, outer);
  }
  private async receive(
    actor: string | null,
    input: ReturnReceipt,
    outer?: TransactionContext,
    cancelledOrder = false,
  ): Promise<void> {
    const amount = quantity(input.quantity),
      expiry = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiry && !Number.isFinite(expiry.getTime())) throw new Error('INVALID_INPUT');
    const run = async (tx: TransactionContext) => {
      if (
        !cancelledOrder &&
        (!actor || !(await this.identity.hasStoreRole(actor, input.storeId, ['STORE_MANAGER'], tx)))
      )
        throw new Error('STORE_NOT_FOUND');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-order:${input.orderId}`},0))`.execute(
        tx,
      );
      const reference = `return:${input.returnId}`;
      if (!(await operation(tx, reference, 'RETURN_RECEIVED', { actor, ...input }))) return;
      await lockStock(tx, [
        { storeId: input.storeId, variantId: input.variantId, quantity: input.quantity },
      ]);
      const picked = await sql<{
        picked: string;
        returned: string;
      }>`SELECT COALESCE((SELECT -sum(on_hand_delta) FROM inventory_ledger WHERE (reference=${`pick:${input.orderId}`} OR reference LIKE ${`pick:${input.orderId}:g%`}) AND store_id=${input.storeId}::uuid AND variant_id=${input.variantId}::uuid AND kind='RESERVE_COMMIT_PICK'),0)::text AS picked, COALESCE((SELECT sum(quantity) FROM inventory_returns WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.variantId}::uuid),0)::text AS returned`.execute(
        tx,
      );
      if (BigInt(picked.rows[0]!.returned) + amount > BigInt(picked.rows[0]!.picked))
        throw new Error('RETURN_QUANTITY_EXCEEDED');
      const product = await sql<{
        expiry_tracking: boolean;
      }>`SELECT p.expiry_tracking FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.id=${input.variantId}::uuid`.execute(
        tx,
      );
      if (!product.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (product.rows[0].expiry_tracking && !expiry) throw new Error('INVALID_INPUT');
      const batch = uuidV7();
      await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,expires_at,state,on_hand) VALUES(${batch}::uuid,${input.storeId}::uuid,${input.variantId}::uuid,${`return:${input.returnId}`},${expiry},'QUARANTINED',0)`.execute(
        tx,
      );
      await sql`INSERT INTO inventory_returns(id,order_id,store_id,variant_id,batch_id,quantity,status) VALUES(${input.returnId}::uuid,${input.orderId}::uuid,${input.storeId}::uuid,${input.variantId}::uuid,${batch}::uuid,${input.quantity}::bigint,'QUARANTINED')`.execute(
        tx,
      );
      await movement(tx, {
        reference,
        storeId: input.storeId,
        variantId: input.variantId,
        batchId: batch,
        kind: 'RETURN_RECEIVED',
        onHand: amount,
        reserved: 0n,
        actor: actor ?? undefined,
      });
      await stockAlerts(tx, input.storeId, input.variantId);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_RETURN_RECEIVED','inventory_return',${input.returnId},${JSON.stringify({ orderId: input.orderId, quantity: input.quantity })}::jsonb)`.execute(
        tx,
      );
    };
    if (outer) await run(outer);
    else await transactionWithRetry(this.db, run);
  }
  async inspectReturn(
    actor: string,
    returnId: string,
    result: 'APPROVE' | 'REJECT',
    reason: string,
  ): Promise<void> {
    if (!['APPROVE', 'REJECT'].includes(result) || !reason.trim() || reason.length > 500)
      throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      const record = await sql<{
        store_id: string;
        variant_id: string;
        batch_id: string;
      }>`SELECT store_id,variant_id,batch_id FROM inventory_returns WHERE id=${returnId}::uuid`.execute(
        tx,
      );
      const row = record.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (!(await this.identity.hasStoreRole(actor, row.store_id, ['STORE_MANAGER'], tx)))
        throw new Error('STORE_NOT_FOUND');
      const reference = `return-qc:${returnId}`;
      if (!(await operation(tx, reference, 'RETURN_QC', { actor, returnId, result, reason })))
        return;
      await lockStock(tx, [{ storeId: row.store_id, variantId: row.variant_id, quantity: '1' }]);
      const batch = await sql<{
        state: string;
        expires_at: Date | null;
        min_seconds: number;
      }>`SELECT b.state,b.expires_at,COALESCE(s.min_seconds,0) AS min_seconds FROM inventory_batches b JOIN catalog_variants v ON v.id=b.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE b.id=${row.batch_id}::uuid FOR UPDATE OF b`.execute(
        tx,
      );
      const now = await databaseTimeAfterLock(tx);
      const b = batch.rows[0]!;
      if (
        b.state !== 'QUARANTINED' ||
        (result === 'APPROVE' &&
          b.expires_at &&
          b.expires_at.getTime() <= now.getTime() + b.min_seconds * 1000)
      )
        throw new Error('BATCH_NOT_ELIGIBLE');
      await sql`UPDATE inventory_batches SET state=${result === 'APPROVE' ? 'ACTIVE' : 'DAMAGED'} WHERE id=${row.batch_id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE inventory_returns SET status=${result === 'APPROVE' ? 'APPROVED' : 'REJECTED'},inspected_by=${actor}::uuid,inspected_at=clock_timestamp(),reason=${reason} WHERE id=${returnId}::uuid`.execute(
        tx,
      );
      const version = await sql<{
        version: string;
      }>`UPDATE store_inventory SET version=version+1 WHERE store_id=${row.store_id}::uuid AND variant_id=${row.variant_id}::uuid RETURNING version::text`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_RETURN_INSPECTED','inventory_return',${returnId},${JSON.stringify({ result, reason })}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${uuidV7()}::uuid,'inventory.return_inspected',1,'inventory_batch',${row.batch_id}::uuid,${version.rows[0]!.version}::bigint,${reference},${JSON.stringify({ returnId, result })}::jsonb)`.execute(
        tx,
      );
      await stockAlerts(tx, row.store_id, row.variant_id);
    });
  }
}
