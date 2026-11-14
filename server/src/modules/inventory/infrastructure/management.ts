import { stockAlerts } from './alerts.js';
import { stockCursor, stockCursorId } from './paging.js';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { InventoryManagement, ReceiptInput } from '../contracts/inventory.js';
import { quantity } from '../domain/quantity.js';
import { lockStock, movement, operation } from './stock-primitives.js';

export class PostgresInventoryManagement implements InventoryManagement {
  async setBinLocation(
    actor: string,
    storeId: string,
    variantId: string,
    location: string,
  ): Promise<void> {
    if (!location.trim() || location.length > 60) throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      if (!(await this.identity.hasStoreRole(actor, storeId, ['STORE_MANAGER'], tx)))
        throw new Error('STORE_NOT_FOUND');
      const updated =
        await sql`UPDATE store_inventory SET bin_location=${location.trim()},version=version+1
        WHERE store_id=${storeId}::uuid AND variant_id=${variantId}::uuid RETURNING variant_id`.execute(
          tx,
        );
      if (!updated.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,
        'INVENTORY_BIN_UPDATED','store',${storeId},${JSON.stringify({ variantId, binLocation: location.trim() })}::jsonb)`.execute(
        tx,
      );
    });
  }
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}
  async receive(actor: string, input: ReceiptInput): Promise<void> {
    const amount = quantity(input.quantity);
    const expiry = input.expiresAt ? new Date(input.expiresAt) : null;
    if (
      !input.batchCode.trim() ||
      input.batchCode.length > 120 ||
      (expiry && !Number.isFinite(expiry.getTime()))
    )
      throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => {
      if (!(await this.identity.hasStoreRole(actor, input.storeId, ['STORE_MANAGER'], tx)))
        throw new Error('STORE_NOT_FOUND');
      const reference = `receipt:${input.storeId}:${actor}:${input.reference}`;
      if (
        !(await operation(tx, reference, 'RECEIPT', {
          actor,
          ...input,
          expiresAt: input.expiresAt ?? null,
        }))
      )
        return;
      await lockStock(tx, [input]);
      const product = await sql<{
        expiry_tracking: boolean;
      }>`SELECT p.expiry_tracking FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.id=${input.variantId}::uuid AND v.deleted_at IS NULL AND p.deleted_at IS NULL`.execute(
        tx,
      );
      if (!product.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (product.rows[0].expiry_tracking && !expiry) throw new Error('INVALID_INPUT');
      const batch = await sql<{
        id: string;
        expires_at: Date | null;
        state: string;
      }>`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,expires_at,state,on_hand) VALUES(${uuidV7()}::uuid,${input.storeId}::uuid,${input.variantId}::uuid,${input.batchCode},${expiry},'ACTIVE',0) ON CONFLICT(store_id,variant_id,batch_code) DO UPDATE SET batch_code=EXCLUDED.batch_code RETURNING id,expires_at,state`.execute(
        tx,
      );
      const row = batch.rows[0]!;
      if (row.state !== 'ACTIVE' || row.expires_at?.getTime() !== expiry?.getTime())
        throw new Error('RESOURCE_CONFLICT');
      await movement(tx, {
        reference,
        storeId: input.storeId,
        variantId: input.variantId,
        batchId: row.id,
        kind: 'RECEIPT',
        onHand: amount,
        reserved: 0n,
        actor,
      });
      await stockAlerts(tx, input.storeId, input.variantId);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_RECEIVED','inventory_batch',${row.id},${JSON.stringify({ reference, quantity: input.quantity })}::jsonb)`.execute(
        tx,
      );
    });
  }
  private bound(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
  }
  async list(
    actor: string,
    storeId: string,
    search: string,
    cursor?: string,
    limit = 50,
    lowStock?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!(await this.identity.hasStoreRole(actor, storeId, ['STORE_MANAGER'])))
      throw new Error('STORE_NOT_FOUND');
    this.bound(limit);
    const scope = ['stock', storeId, search, lowStock ?? null];
    const after = stockCursorId(cursor, scope);
    if (search.length > 100) throw new Error('INVALID_INPUT');
    const rows = await sql<{
      variantId: string;
    }>`SELECT i.variant_id AS "variantId",i.bin_location AS "binLocation",v.sku,v.barcode,p.name,i.on_hand::text AS "onHand",i.reserved::text,a.available::text,i.version::text FROM store_inventory i JOIN catalog_variants v ON v.id=i.variant_id JOIN catalog_products p ON p.id=v.product_id JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id WHERE i.store_id=${storeId}::uuid AND (${after}::uuid IS NULL OR i.variant_id>${after}::uuid) AND (${lowStock ?? null}::bigint IS NULL OR a.available<=${lowStock ?? null}::bigint) AND (${search}='' OR p.name ILIKE '%'||${search}||'%' OR v.sku ILIKE '%'||${search}||'%' OR v.barcode=${search}) ORDER BY i.variant_id LIMIT ${limit + 1}`.execute(
      this.db,
    );
    return {
      items: rows.rows.slice(0, limit),
      nextCursor:
        rows.rows.length > limit ? stockCursor(rows.rows[limit - 1]!.variantId, scope) : null,
    };
  }
  async expiring(
    actor: string,
    storeId: string,
    days: number,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!(await this.identity.hasStoreRole(actor, storeId, ['STORE_MANAGER'])))
      throw new Error('STORE_NOT_FOUND');
    this.bound(limit);
    const scope = ['expiring', storeId, days];
    const after = stockCursorId(cursor, scope);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('INVALID_INPUT');
    const rows = await sql<{
      id: string;
    }>`SELECT id,variant_id AS "variantId",batch_code AS "batchCode",expires_at AS "expiresAt",state,on_hand::text AS "onHand",reserved::text FROM inventory_batches WHERE store_id=${storeId}::uuid AND on_hand>0 AND expires_at IS NOT NULL AND expires_at<=clock_timestamp()+${days}*interval '1 day' AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
      this.db,
    );
    return {
      items: rows.rows.slice(0, limit),
      nextCursor: rows.rows.length > limit ? stockCursor(rows.rows[limit - 1]!.id, scope) : null,
    };
  }
  async report(
    actor: string,
    storeId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    this.bound(limit);
    const scope = ['report', storeId];
    const after = stockCursorId(cursor, scope);
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const rows = await sql<{
        variantId: string;
      }>`SELECT i.variant_id AS "variantId",i.on_hand::text AS "onHand",i.reserved::text,a.available::text,i.version::text FROM store_inventory i JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id WHERE i.store_id=${storeId}::uuid AND (${after}::uuid IS NULL OR i.variant_id>${after}::uuid) ORDER BY i.variant_id LIMIT ${limit + 1}`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_REPORT_READ','store',${storeId})`.execute(
        tx,
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor:
          rows.rows.length > limit ? stockCursor(rows.rows[limit - 1]!.variantId, scope) : null,
      };
    });
  }
  async ledger(
    actor: string,
    storeId: string,
    variantId?: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    this.bound(limit);
    const scope = ['ledger', storeId, variantId ?? null];
    const after = stockCursorId(cursor, scope);
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const rows = await sql<{
        id: string;
      }>`SELECT id,reference,variant_id AS "variantId",batch_id AS "batchId",kind,on_hand_delta::text AS "onHandDelta",reserved_delta::text AS "reservedDelta",actor_id AS "actorId",created_at AS "createdAt" FROM inventory_ledger WHERE store_id=${storeId}::uuid AND (${variantId ?? null}::uuid IS NULL OR variant_id=${variantId ?? null}::uuid) AND (${after}::uuid IS NULL OR id<${after}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_LEDGER_READ','store',${storeId})`.execute(
        tx,
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor: rows.rows.length > limit ? stockCursor(rows.rows[limit - 1]!.id, scope) : null,
      };
    });
  }
}
