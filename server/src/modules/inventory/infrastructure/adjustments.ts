import { claimCount } from './count-claim.js';
import { stockAlerts } from './alerts.js';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type Json,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { ApprovalExecutor, ApprovalFactory } from '../../compliance/contracts/approval.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { CountInput, InventoryAdjustments } from '../contracts/adjustments.js';
import { quantity } from '../domain/quantity.js';
import { fingerprint, lockStock, movement, operation } from './stock-primitives.js';

function validPayload(value: Json): value is { [key: string]: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [
      'maker',
      'storeId',
      'variantId',
      'batchId',
      'counted',
      'expectedVersion',
      'reason',
      'reference',
    ].every((k) => typeof value[k] === 'string')
  );
}
export class PostgresAdjustments implements InventoryAdjustments {
  private readonly approvals: ApprovalExecutor;
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly config: AppConfig,
    factory: ApprovalFactory,
  ) {
    this.approvals = factory.create({
      INVENTORY_COUNT: {
        version: 1,
        makerRole: 'STORE_MANAGER',
        checkerRole: 'STORE_MANAGER',
        ttlSeconds: 86400,
        validate: validPayload,
        execute: async (tx, payload, _execution, checker) => {
          if (!validPayload(payload)) throw new Error('INVALID_APPROVAL');
          const input = payload as unknown as CountInput & { maker: string };
          if (
            !(await this.identity.hasStoreRole(
              input.maker,
              input.storeId,
              ['STORE_MANAGER'],
              tx,
            )) ||
            !(await this.identity.hasStoreRole(checker, input.storeId, ['STORE_MANAGER'], tx))
          )
            throw new Error('FORBIDDEN');
          await this.apply(tx, input.maker, input, checker);
        },
      },
    });
  }
  async count(actor: string, input: CountInput): Promise<{ approvalId?: string }> {
    quantity(input.counted, true);
    quantity(input.expectedVersion);
    if (
      !input.reference ||
      input.reference.length > 150 ||
      !input.reason.trim() ||
      input.reason.length > 500
    )
      throw new Error('INVALID_INPUT');
    const threshold = await this.config.get('inventoryAdjustmentApprovalUnits');
    const approvalRequired = await claimCount(this.db, this.identity, actor, input, threshold);
    const payload = { ...input, maker: actor };
    const existing = await sql<{
      id: string;
      payload: Json;
    }>`SELECT id,payload FROM maker_checker_requests WHERE action='INVENTORY_COUNT' AND payload->>'reference'=${input.reference} AND payload->>'storeId'=${input.storeId} AND payload->>'maker'=${actor}`.execute(
      this.db,
    );
    if (existing.rows[0]) {
      if (
        !validPayload(existing.rows[0].payload) ||
        Object.entries(payload).some(
          ([k, v]) => (existing.rows[0]!.payload as { [key: string]: Json })[k] !== v,
        )
      )
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      return { approvalId: existing.rows[0].id };
    }
    const prior = await sql<{
      kind: string;
      request_hash: string;
    }>`SELECT kind,request_hash FROM inventory_operations WHERE reference=${`count:${input.storeId}:${actor}:${input.reference}`}`.execute(
      this.db,
    );
    if (prior.rows[0]) {
      if (
        prior.rows[0].kind !== 'COUNT' ||
        prior.rows[0].request_hash !== fingerprint({ actor, ...input })
      )
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      return {};
    }
    if (approvalRequired) {
      try {
        return { approvalId: await this.approvals.request(actor, 'INVENTORY_COUNT', payload) };
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== '23505'
        )
          throw error;
        const concurrent = await sql<{
          id: string;
          payload: Json;
        }>`SELECT id,payload FROM maker_checker_requests WHERE action='INVENTORY_COUNT' AND payload->>'reference'=${input.reference} AND payload->>'storeId'=${input.storeId} AND payload->>'maker'=${actor}`.execute(
          this.db,
        );
        const row = concurrent.rows[0];
        if (
          !row ||
          !validPayload(row.payload) ||
          Object.entries(payload).some(
            ([k, v]) => (row.payload as { [key: string]: Json })[k] !== v,
          )
        )
          throw new Error('IDEMPOTENCY_KEY_REUSED', { cause: error });
        return { approvalId: row.id };
      }
    }
    await transactionWithRetry(this.db, async (tx) => {
      if (!(await this.identity.hasStoreRole(actor, input.storeId, ['STORE_MANAGER'], tx)))
        throw new Error('STORE_NOT_FOUND');
      await this.apply(tx, actor, input);
    });
    return {};
  }
  async approve(actor: string, id: string, reference: string): Promise<void> {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    const existing = await this.db.transaction().execute(async (tx) => {
      const row = await sql<{
        status: string;
        checker_id: string | null;
        payload: Json;
      }>`SELECT status,checker_id,payload FROM maker_checker_requests WHERE id=${id}::uuid AND action='INVENTORY_COUNT' FOR SHARE`.execute(
        tx,
      );
      if (!row.rows[0] || !validPayload(row.rows[0].payload)) throw new Error('APPROVAL_INVALID');
      const payload = row.rows[0].payload;
      if (!(await this.identity.hasStoreRole(actor, payload.storeId!, ['STORE_MANAGER'], tx)))
        throw new Error('FORBIDDEN');
      const claim =
        await sql`INSERT INTO inventory_approval_keys(actor_id,reference,approval_id) VALUES(${actor}::uuid,${reference},${id}::uuid) ON CONFLICT DO NOTHING RETURNING approval_id`.execute(
          tx,
        );
      if (!claim.rows.length) {
        const prior = await sql<{
          approval_id: string;
        }>`SELECT approval_id FROM inventory_approval_keys WHERE actor_id=${actor}::uuid AND reference=${reference}`.execute(
          tx,
        );
        if (prior.rows[0]?.approval_id !== id) throw new Error('IDEMPOTENCY_KEY_REUSED');
      }
      return row.rows[0];
    });
    if (existing.status === 'EXECUTED' && existing.checker_id === actor) return;
    try {
      await this.approvals.approve(actor, id);
    } catch (error) {
      const after = await sql<{
        status: string;
        checker_id: string | null;
      }>`SELECT status,checker_id FROM maker_checker_requests WHERE id=${id}::uuid AND action='INVENTORY_COUNT'`.execute(
        this.db,
      );
      if (after.rows[0]?.status === 'EXECUTED' && after.rows[0].checker_id === actor) return;
      throw error;
    }
  }
  private async apply(
    tx: TransactionContext,
    actor: string,
    input: CountInput,
    checker?: string,
  ): Promise<void> {
    const reference = `count:${input.storeId}:${actor}:${input.reference}`;
    const { storeId, variantId, batchId, counted, expectedVersion, reason } = input;
    if (
      !(await operation(tx, reference, 'COUNT', {
        actor,
        storeId,
        variantId,
        batchId,
        counted,
        expectedVersion,
        reason,
        reference: input.reference,
        ...(input.kind ? { kind: input.kind } : {}),
      }))
    )
      return;
    await lockStock(tx, [{ storeId: input.storeId, variantId: input.variantId, quantity: '1' }]);
    const row = await sql<{
      on_hand: string;
      reserved: string;
      version: string;
      state: string;
      expires_at: Date | null;
      now: Date;
    }>`SELECT b.on_hand::text,b.reserved::text,i.version::text,b.state,b.expires_at,clock_timestamp() AS now FROM inventory_batches b JOIN store_inventory i ON i.store_id=b.store_id AND i.variant_id=b.variant_id WHERE b.id=${input.batchId}::uuid AND b.store_id=${input.storeId}::uuid AND b.variant_id=${input.variantId}::uuid FOR UPDATE OF b`.execute(
      tx,
    );
    if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    const current = row.rows[0],
      countedValue = quantity(input.counted, true);
    if (current.version !== input.expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
    if (
      countedValue > BigInt(current.on_hand) &&
      (current.state !== 'ACTIVE' || (current.expires_at && current.expires_at <= current.now))
    )
      throw new Error('BATCH_NOT_ELIGIBLE');
    if (countedValue < BigInt(current.reserved)) throw new Error('INVENTORY_RESERVED');
    await movement(tx, {
      reference,
      storeId: input.storeId,
      variantId: input.variantId,
      batchId: input.batchId,
      kind: input.kind ?? 'CYCLE_COUNT',
      onHand: countedValue - BigInt(current.on_hand),
      reserved: 0n,
      actor,
    });
    await stockAlerts(tx, input.storeId, input.variantId);
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'INVENTORY_COUNT','inventory_batch',${input.batchId},${JSON.stringify({ reason: input.reason, counted: input.counted, checker: checker ?? null, reference })}::jsonb)`.execute(
      tx,
    );
  }
}
