import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import { INVENTORY_CONFIG_DEFAULTS } from '../../app-config/contracts/config.js';

/** Called after all movements, so the outbox records the committed final state. */
export async function stockAlerts(
  tx: TransactionContext,
  storeId: string,
  variantId: string,
): Promise<void> {
  const rows = await sql<{
    id: string;
    version: string;
    available: string;
    low: boolean;
    expiring: boolean;
  }>`SELECT b.id,i.version::text,a.available::text,
    a.available<=COALESCE((SELECT (value #>> '{}')::bigint FROM app_config WHERE key='catalogLowStockThreshold'),${INVENTORY_CONFIG_DEFAULTS.catalogLowStockThreshold}) AS low,
    b.expires_at IS NOT NULL AND b.expires_at>clock_timestamp() AND b.expires_at<=clock_timestamp()+COALESCE((SELECT (value #>> '{}')::integer FROM app_config WHERE key='inventoryExpirySoonDays'),${INVENTORY_CONFIG_DEFAULTS.inventoryExpirySoonDays})*interval '1 day' AND b.on_hand>0 AS expiring
    FROM store_inventory i JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id JOIN inventory_batches b ON b.store_id=i.store_id AND b.variant_id=i.variant_id
    WHERE i.store_id=${storeId}::uuid AND i.variant_id=${variantId}::uuid ORDER BY b.id`.execute(
    tx,
  );
  const first = rows.rows[0];
  if (first?.low)
    await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${uuidV7()}::uuid,'inventory.low_stock',1,'inventory_alert',${first.id}::uuid,${first.version}::bigint,${storeId},${JSON.stringify({ storeId, variantId, available: first.available })}::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`.execute(
      tx,
    );
  for (const row of rows.rows.filter((r) => r.expiring))
    await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${uuidV7()}::uuid,'inventory.expiry_soon',1,'inventory_alert',${row.id}::uuid,1,${storeId},${JSON.stringify({ storeId, variantId, batchId: row.id })}::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`.execute(
      tx,
    );
}
