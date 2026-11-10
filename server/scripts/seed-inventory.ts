import type { Client } from 'pg';
import { createDatabase, databaseIamRegion } from '../src/platform/database/database.js';
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
  const seedManagerId: string = managerId;
  const variants = await client.query<{
    id: string;
    expires_at: Date | null;
    batch_id: string | null;
  }>(
    "SELECT v.id,b.id AS batch_id,b.expires_at FROM catalog_variants v LEFT JOIN inventory_batches b ON b.store_id=$1 AND b.variant_id=v.id AND b.batch_code='LOCAL-OPENING' WHERE v.sku LIKE 'LOCAL-%' AND v.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM inventory_ledger l WHERE l.reference='seed-opening:' || $1::text || ':' || v.id::text AND l.store_id=$1 AND l.variant_id=v.id AND l.kind='RECEIPT' AND l.on_hand_delta=20) ORDER BY v.id",
    [storeId],
  );
  const database = createDatabase(
    databaseUrl,
    8,
    30000,
    undefined,
    60000,
    databaseIamRegion(process.env),
  );
  try {
    const inventory = new PostgresInventoryManagement(
      database.db,
      new DatabaseIdentityAccess(database.db),
    );
    let next = 0;
    async function receiveNext(): Promise<void> {
      for (;;) {
        const variant = variants.rows[next++];
        if (!variant) return;
        // Demo stock deliberately has a long, explicit expiry; reruns preserve that value.
        const expiry = variant.batch_id
          ? (variant.expires_at?.toISOString() ?? null)
          : new Date(Date.now() + 365 * 86400000).toISOString();
        await inventory.receive(seedManagerId, {
          storeId,
          variantId: variant.id,
          batchCode: 'LOCAL-OPENING',
          quantity: '20',
          expiresAt: expiry,
          reference: `seed-opening:${storeId}:${variant.id}`,
        });
      }
    }
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(4, variants.rows.length) }, () => receiveNext()),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  } finally {
    await database.close();
  }
}
