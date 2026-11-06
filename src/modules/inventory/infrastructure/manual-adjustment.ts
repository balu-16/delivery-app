import { sql } from 'kysely';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { InventoryAdjustments } from '../contracts/adjustments.js';
import type {
  InventoryManualAdjustment,
  ManualAdjustmentInput,
} from '../contracts/manual-adjustment.js';
import { quantity } from '../domain/quantity.js';
import { fingerprint, lockStock } from './stock-primitives.js';
export class PostgresManualAdjustment implements InventoryManualAdjustment {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly counts: InventoryAdjustments,
  ) {}
  async adjust(actor: string, input: ManualAdjustmentInput): Promise<{ approvalId?: string }> {
    if (!/^-?[1-9][0-9]{0,18}$/.test(input.delta)) throw new Error('INVALID_QUANTITY');
    const delta = BigInt(input.delta);
    quantity((delta < 0n ? -delta : delta).toString());
    quantity(input.expectedVersion);
    if (
      !input.reference ||
      input.reference.length > 150 ||
      !input.reason.trim() ||
      input.reason.length > 500
    )
      throw new Error('INVALID_INPUT');
    const hash = fingerprint(input);
    const counted = await transactionWithRetry(this.db, async (tx) => {
      if (!(await this.identity.hasStoreRole(actor, input.storeId, ['STORE_MANAGER'], tx)))
        throw new Error('STORE_NOT_FOUND');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`manual-adjustment:${actor}:${input.storeId}:${input.reference}`},0))`.execute(
        tx,
      );
      const old = await sql<{
        request_hash: string;
        counted: string;
      }>`SELECT request_hash,counted::text FROM inventory_manual_adjustments WHERE actor_id=${actor}::uuid AND store_id=${input.storeId}::uuid AND reference=${input.reference}`.execute(
        tx,
      );
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return old.rows[0].counted;
      }
      await lockStock(tx, [{ storeId: input.storeId, variantId: input.variantId, quantity: '1' }]);
      const row = await sql<{
        on_hand: string;
        version: string;
      }>`SELECT b.on_hand::text,i.version::text FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.id=${input.batchId}::uuid AND b.store_id=${input.storeId}::uuid AND b.variant_id=${input.variantId}::uuid FOR UPDATE OF b`.execute(
        tx,
      );
      if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (row.rows[0].version !== input.expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
      const value = BigInt(row.rows[0].on_hand) + delta;
      if (value < 0n) throw new Error('INVALID_QUANTITY');
      quantity(value.toString(), true);
      await sql`INSERT INTO inventory_manual_adjustments(actor_id,store_id,reference,request_hash,counted) VALUES(${actor}::uuid,${input.storeId}::uuid,${input.reference},${hash},${value.toString()}::bigint)`.execute(
        tx,
      );
      return value.toString();
    });
    return this.counts.count(actor, {
      storeId: input.storeId,
      variantId: input.variantId,
      batchId: input.batchId,
      counted,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      reference: `adjust-${fingerprint(input.reference)}`,
      kind: 'ADJUSTMENT',
    });
  }
}
