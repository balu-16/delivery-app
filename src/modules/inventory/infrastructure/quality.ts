import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { BatchQualityInput, InventoryQuality } from '../contracts/quality.js';
import { lockStock, operation } from './stock-primitives.js';
import { stockAlerts } from './alerts.js';
export class PostgresInventoryQuality implements InventoryQuality {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}
  async setState(actor: string, input: BatchQualityInput): Promise<void> {
    if (
      !['QUARANTINED', 'DAMAGED'].includes(input.state) ||
      !input.reason.trim() ||
      input.reason.length > 500 ||
      !input.reference ||
      input.reference.length > 150
    )
      throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      if (!(await this.identity.hasStoreRole(actor, input.storeId, ['STORE_MANAGER'], tx)))
        throw new Error('STORE_NOT_FOUND');
      const reference = `quality:${input.storeId}:${actor}:${input.reference}`;
      if (!(await operation(tx, reference, 'QUALITY', { actor, ...input }))) return;
      await lockStock(tx, [{ storeId: input.storeId, variantId: input.variantId, quantity: '1' }]);
      const batch = await sql<{
        state: string;
      }>`SELECT state FROM inventory_batches WHERE id=${input.batchId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.variantId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!batch.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (batch.rows[0].state === 'DAMAGED' && input.state !== 'DAMAGED')
        throw new Error('BATCH_NOT_ELIGIBLE');
      await sql`UPDATE inventory_batches SET state=${input.state} WHERE id=${input.batchId}::uuid`.execute(
        tx,
      );
      const version = await sql<{
        version: string;
      }>`UPDATE store_inventory SET version=version+1 WHERE store_id=${input.storeId}::uuid AND variant_id=${input.variantId}::uuid RETURNING version::text`.execute(
        tx,
      );
      await sql`INSERT INTO inventory_shortfall_obligations(id,order_id,store_id,variant_id,batch_id,quantity,reason) SELECT gen_random_uuid(),a.order_id,a.store_id,a.variant_id,a.batch_id,a.quantity,${input.state} FROM inventory_allocations a JOIN inventory_reservations r ON r.order_id=a.order_id AND r.store_id=a.store_id AND r.variant_id=a.variant_id WHERE a.batch_id=${input.batchId}::uuid AND r.state<>'RESOLVED' ON CONFLICT(order_id,store_id,variant_id,batch_id,reason) DO UPDATE SET quantity=EXCLUDED.quantity,resolved_at=NULL`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_BATCH_STATE_CHANGED','inventory_batch',${input.batchId},${JSON.stringify({ previous: batch.rows[0].state, state: input.state, reason: input.reason, reference })}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${uuidV7()}::uuid,'inventory.batch_state_changed',1,'inventory_batch',${input.batchId}::uuid,${version.rows[0]!.version}::bigint,${reference},${JSON.stringify({ storeId: input.storeId, variantId: input.variantId, batchId: input.batchId, state: input.state })}::jsonb)`.execute(
        tx,
      );
      await stockAlerts(tx, input.storeId, input.variantId);
    });
  }
}
