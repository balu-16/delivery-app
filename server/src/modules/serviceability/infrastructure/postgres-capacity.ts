import { sql, type Kysely, type Transaction } from 'kysely';
import type { PlatformSchema } from '../../../platform/database/database.js';
import type { CapacityClaims } from '../contracts/serviceability.js';

type Tx = Transaction<PlatformSchema>;
/** Call within the same transaction as the order or subscription occurrence. */
export async function claimCapacityInTransaction(
  tx: Tx,
  storeId: string,
  slotStart: Date,
  reference: string,
): Promise<'CLAIMED' | 'ALREADY_CLAIMED' | 'AT_CAPACITY'> {
  if (!Number.isFinite(slotStart.getTime()) || !reference || reference.length > 200)
    throw new Error('INVALID_CAPACITY_CLAIM');
  // Store capacity is an Asia/Kolkata local-hour bucket. Accept any instant in
  // the target hour so callers cannot accidentally create parallel buckets.
  const store = await sql<{
    slot: Date;
    hourly_capacity: number;
  }>`SELECT hourly_capacity,
       (date_trunc('hour', ${slotStart}::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS slot
     FROM stores WHERE id=${storeId} FOR UPDATE`.execute(tx);
  if (!store.rows[0]) throw new Error('STORE_NOT_FOUND');
  const slot = store.rows[0].slot;
  // A configuration change applies to existing future buckets without undoing
  // already admitted orders. The store lock serializes this with admin edits.
  const bucket = await sql<{
    capacity: number;
    claimed: number;
  }>`INSERT INTO store_capacity_buckets(store_id, slot_start, capacity)
      VALUES (${storeId}, ${slot}, ${store.rows[0].hourly_capacity})
      ON CONFLICT (store_id, slot_start) DO UPDATE
        SET capacity=GREATEST(store_capacity_buckets.claimed,EXCLUDED.capacity)
      RETURNING capacity,claimed`.execute(tx);
  const current = bucket.rows[0];
  if (!current) throw new Error('CAPACITY_BUCKET_MISSING');
  const result = await sql<{ result: 'CLAIMED' | 'ALREADY_CLAIMED' | 'AT_CAPACITY' }>`
    WITH old AS (
      SELECT 1 FROM store_capacity_claims
      WHERE store_id=${storeId} AND slot_start=${slot} AND reference=${reference}
    ), inserted AS (
      INSERT INTO store_capacity_claims(store_id,slot_start,reference)
      SELECT ${storeId},${slot},${reference}
      WHERE ${current.claimed}::integer < ${current.capacity}::integer AND NOT EXISTS (SELECT 1 FROM old)
      RETURNING 1
    ), updated AS (
      UPDATE store_capacity_buckets SET claimed=claimed+1
      WHERE store_id=${storeId} AND slot_start=${slot} AND EXISTS (SELECT 1 FROM inserted)
      RETURNING 1
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM old) THEN 'ALREADY_CLAIMED'
      WHEN EXISTS (SELECT 1 FROM updated) THEN 'CLAIMED' ELSE 'AT_CAPACITY' END AS result`.execute(
    tx,
  );
  if (!result.rows[0]) throw new Error('CAPACITY_CLAIM_FAILED');
  return result.rows[0].result;
}
export class PostgresCapacityClaims implements CapacityClaims {
  constructor(private readonly db: Kysely<PlatformSchema>) {}
  claim(storeId: string, slotStart: Date, reference: string, tx?: Tx) {
    if (tx) return claimCapacityInTransaction(tx, storeId, slotStart, reference);
    return this.db
      .transaction()
      .execute((tx) => claimCapacityInTransaction(tx, storeId, slotStart, reference));
  }
  release(reference: string, outer?: Tx): Promise<boolean> {
    if (!reference || reference.length > 200) throw new Error('INVALID_CAPACITY_CLAIM');
    const run = async (tx: Tx): Promise<boolean> => {
      const claims = await sql<{ store_id: string; slot_start: Date }>`SELECT store_id,slot_start
        FROM store_capacity_claims WHERE reference=${reference} ORDER BY store_id,slot_start`.execute(
        tx,
      );
      let released = false;
      for (const claim of claims.rows) {
        await sql`SELECT id FROM stores WHERE id=${claim.store_id}::uuid FOR UPDATE`.execute(tx);
        await sql`SELECT store_id FROM store_capacity_buckets WHERE store_id=${claim.store_id}::uuid
          AND slot_start=${claim.slot_start} FOR UPDATE`.execute(tx);
        const removed =
          await sql`DELETE FROM store_capacity_claims WHERE store_id=${claim.store_id}::uuid
          AND slot_start=${claim.slot_start} AND reference=${reference}`.execute(tx);
        if (removed.numAffectedRows) {
          await sql`UPDATE store_capacity_buckets SET claimed=claimed-1
            WHERE store_id=${claim.store_id}::uuid AND slot_start=${claim.slot_start}`.execute(tx);
          released = true;
        }
      }
      return released;
    };
    return outer ? run(outer) : this.db.transaction().execute(run);
  }
}
