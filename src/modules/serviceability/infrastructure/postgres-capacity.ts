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
  const normalized = await sql<{
    slot: Date;
  }>`SELECT (date_trunc('hour', ${slotStart}::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS slot`.execute(
    tx,
  );
  const slot = normalized.rows[0]!.slot;
  const store = await sql<{
    hourly_capacity: number;
  }>`SELECT hourly_capacity FROM stores WHERE id=${storeId} FOR UPDATE`.execute(tx);
  if (!store.rows[0]) throw new Error('STORE_NOT_FOUND');
  await sql`INSERT INTO store_capacity_buckets(store_id, slot_start, capacity) VALUES (${storeId}, ${slot}, ${store.rows[0].hourly_capacity}) ON CONFLICT (store_id, slot_start) DO NOTHING`.execute(
    tx,
  );
  // A configuration change applies to existing future buckets without undoing
  // already admitted orders. The store lock serializes this with admin edits.
  await sql`UPDATE store_capacity_buckets SET capacity=GREATEST(claimed,${store.rows[0].hourly_capacity}) WHERE store_id=${storeId} AND slot_start=${slot}`.execute(
    tx,
  );
  const bucket = await sql<{
    capacity: number;
    claimed: number;
  }>`SELECT capacity, claimed FROM store_capacity_buckets WHERE store_id=${storeId} AND slot_start=${slot} FOR UPDATE`.execute(
    tx,
  );
  const old =
    await sql`SELECT 1 FROM store_capacity_claims WHERE store_id=${storeId} AND slot_start=${slot} AND reference=${reference}`.execute(
      tx,
    );
  if (old.rows.length) return 'ALREADY_CLAIMED';
  if (!bucket.rows[0] || bucket.rows[0].claimed >= bucket.rows[0].capacity) return 'AT_CAPACITY';
  await sql`INSERT INTO store_capacity_claims(store_id, slot_start, reference) VALUES (${storeId}, ${slot}, ${reference})`.execute(
    tx,
  );
  await sql`UPDATE store_capacity_buckets SET claimed=claimed+1 WHERE store_id=${storeId} AND slot_start=${slot}`.execute(
    tx,
  );
  return 'CLAIMED';
}
export class PostgresCapacityClaims implements CapacityClaims {
  constructor(private readonly db: Kysely<PlatformSchema>) {}
  claim(storeId: string, slotStart: Date, reference: string) {
    return this.db
      .transaction()
      .execute((tx) => claimCapacityInTransaction(tx, storeId, slotStart, reference));
  }
}
