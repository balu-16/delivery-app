import type { Client } from 'pg';
import { uuidV7 } from '../src/common/ids/ids.js';

/** Replay does not override owner edits or enable wallet-funded recurring purchases. */
export async function seedSubscriptions(client: Client, storeIds: readonly string[]) {
  const variant = await client.query<{ id: string }>(
    'SELECT v.id FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.published ORDER BY v.sku,v.id LIMIT 1',
  );
  if (variant.rows[0])
    await client.query(
      'INSERT INTO subscription_plans(id,variant_id) VALUES($1,$2) ON CONFLICT(variant_id) DO NOTHING',
      [uuidV7(), variant.rows[0].id],
    );
  for (const store of storeIds)
    await client.query(
      "INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES($1,$2,'Morning','06:00','09:00') ON CONFLICT(store_id,name) DO NOTHING",
      [uuidV7(), store],
    );
}
