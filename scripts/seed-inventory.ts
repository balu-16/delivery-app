import type { Client } from 'pg';
import { createDatabase } from '../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../src/modules/identity/infrastructure/identity-access.js';
import { PostgresInventoryManagement } from '../src/modules/inventory/infrastructure/management.js';

/** Use the same receipt/ledger path as the API; retries retain original expiry and reference. */
export async function seedInventory(
  client: Client,
  storeId: string,
  databaseUrl: string,
): Promise<void> {
  const manager = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE pool='WORKFORCE' AND cognito_sub='manager'",
  );
  const managerId = manager.rows[0]?.id;
  if (!managerId) throw new Error('Seed store manager missing');
  const variants = await client.query<{
    id: string;
    expires_at: Date | null;
    batch_id: string | null;
  }>(
    "SELECT v.id,b.id AS batch_id,b.expires_at FROM catalog_variants v LEFT JOIN inventory_batches b ON b.store_id=$1 AND b.variant_id=v.id AND b.batch_code='LOCAL-OPENING' WHERE v.sku LIKE 'LOCAL-%' AND v.deleted_at IS NULL ORDER BY v.id",
    [storeId],
  );
  const database = createDatabase(databaseUrl);
  try {
    const inventory = new PostgresInventoryManagement(
      database.db,
      new DatabaseIdentityAccess(database.db),
    );
    for (const variant of variants.rows) {
      // Demo stock deliberately has a long, explicit expiry; reruns preserve that value.
      const expiry = variant.batch_id
        ? (variant.expires_at?.toISOString() ?? null)
        : new Date(Date.now() + 365 * 86400000).toISOString();
      await inventory.receive(managerId, {
        storeId,
        variantId: variant.id,
        batchCode: 'LOCAL-OPENING',
        quantity: '20',
        expiresAt: expiry,
        reference: `seed-opening:${storeId}:${variant.id}`,
      });
    }
  } finally {
    await database.close();
  }
}
