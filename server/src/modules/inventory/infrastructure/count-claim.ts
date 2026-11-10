import { sql } from 'kysely';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { CountInput } from '../contracts/adjustments.js';
import { fingerprint, lockStock } from './stock-primitives.js';

/** Persist one decision per key; the transaction ends before execution or approval creation. */
export async function claimCount(
  db: Database,
  identity: IdentityAccess,
  actor: string,
  input: CountInput,
  threshold: number,
): Promise<boolean> {
  return transactionWithRetry(db, async (tx) => {
    if (!(await identity.hasStoreRole(actor, input.storeId, ['STORE_MANAGER'], tx)))
      throw new Error('STORE_NOT_FOUND');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-count:${actor}:${input.storeId}:${input.reference}`},0))`.execute(
      tx,
    );
    const hash = fingerprint({ actor, ...input });
    const existing = await sql<{
      request_hash: string;
      approval_required: boolean;
    }>`SELECT request_hash,approval_required FROM inventory_count_claims WHERE actor_id=${actor}::uuid AND store_id=${input.storeId}::uuid AND reference=${input.reference}`.execute(
      tx,
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return existing.rows[0].approval_required;
    }
    await lockStock(tx, [{ storeId: input.storeId, variantId: input.variantId, quantity: '1' }]);
    const current = await sql<{
      on_hand: string;
      version: string;
    }>`SELECT b.on_hand::text,i.version::text FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.id=${input.batchId}::uuid AND b.store_id=${input.storeId}::uuid AND b.variant_id=${input.variantId}::uuid FOR UPDATE OF b`.execute(
      tx,
    );
    if (!current.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    if (current.rows[0].version !== input.expectedVersion)
      throw new Error('CONCURRENT_MODIFICATION');
    const delta = BigInt(current.rows[0].on_hand) - BigInt(input.counted);
    const approvalRequired = (delta < 0n ? -delta : delta) > BigInt(threshold);
    await sql`INSERT INTO inventory_count_claims(actor_id,store_id,reference,request_hash,approval_required) VALUES(${actor}::uuid,${input.storeId}::uuid,${input.reference},${hash},${approvalRequired})`.execute(
      tx,
    );
    return approvalRequired;
  });
}
