import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { ConfigService } from '../../../config/config.service.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { OrderFulfillment } from '../contracts/fulfillment.js';
import type {
  HandoverCodes,
  HandoverStatus,
  PackInput,
  PickPacking,
} from '../contracts/packing.js';
import { operation } from './pick-primitives.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { fulfillmentCodeKey } from '../../../common/ids/fulfillment-code-keys.js';

function deriveCode(secret: string, orderId: string, riderId?: string | null, version = 1): string {
  const digest = createHmac('sha256', secret)
    .update(`handover:v${version}:${orderId}${riderId ? `:${riderId}` : ''}`)
    .digest();
  return String(digest.readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
}
function codeVerifier(secret: string, orderId: string, code: string): Buffer {
  const key = createHmac('sha256', secret).update('handover:verification:v2').digest();
  return createHmac('sha256', key).update(`${orderId}:${code}`).digest();
}

/** Packing records and handover verification; the derived code is never stored. */
export class PostgresPacking implements PickPacking, HandoverCodes, HandoverStatus {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly config: AppConfig,
    private readonly runtime: ConfigService,
    private readonly fulfillment: OrderFulfillment,
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }

  async pack(actorId: string, orderId: string, input: PackInput, reference: string) {
    if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
    const bags = Number(input.bags);
    if (!Number.isSafeInteger(bags) || bags < 1 || bags > 100) throw new Error('INVALID_INPUT');
    if (!input.sealCode || input.sealCode.length > 64) throw new Error('INVALID_INPUT');
    return this.run(undefined, async (tx) => {
      const order = await sql<{
        on_hold: boolean;
      }>`SELECT on_hold FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
      if (order.rows[0]?.on_hold) throw new Error('ORDER_ON_HOLD');
      const task = await sql<{
        id: string;
        store_id: string;
      }>`SELECT id,store_id FROM pick_tasks WHERE order_id=${orderId}::uuid AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`.execute(
        tx,
      );
      if (!task.rows[0]) throw new Error('PICK_TASK_NOT_COMPLETE');
      if (
        !(await this.identity.hasStoreRole(actorId, task.rows[0].store_id, ['STORE_MANAGER'], tx))
      )
        throw new Error('RESOURCE_NOT_FOUND');
      if (!(await operation(tx, `pack:${orderId}:${reference}`, 'PACK', { orderId, input }))) {
        const existing = await sql<{
          packed_at: Date;
        }>`SELECT packed_at FROM packing_records WHERE order_id=${orderId}::uuid`.execute(tx);
        return { packedAt: existing.rows[0]!.packed_at.toISOString() };
      }
      const existing = await sql<{
        bags: number;
        seal_code: string;
        cold_chain: boolean;
        packed_at: Date;
      }>`SELECT bags,seal_code,cold_chain,packed_at
        FROM packing_records WHERE order_id=${orderId}::uuid`.execute(tx);
      if (existing.rows[0]) {
        if (
          existing.rows[0].bags !== bags ||
          existing.rows[0].seal_code !== input.sealCode ||
          existing.rows[0].cold_chain !== input.coldChain
        )
          throw new Error('RESOURCE_CONFLICT');
        return { packedAt: existing.rows[0].packed_at.toISOString() };
      }
      await sql`INSERT INTO packing_records(order_id,task_id,store_id,bags,seal_code,cold_chain,packed_by) VALUES(${orderId}::uuid,${task.rows[0].id}::uuid,${task.rows[0].store_id}::uuid,${bags},${input.sealCode},${input.coldChain},${actorId}::uuid) ON CONFLICT (order_id) DO NOTHING`.execute(
        tx,
      );
      await this.fulfillment.markPacked(orderId, actorId, tx);
      const version = await sql<{
        version: string;
      }>`SELECT version::text FROM orders WHERE id=${orderId}::uuid`.execute(tx);
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: 'ORDER_PACKED',
          schemaVersion: 1,
          aggregateType: 'order',
          aggregateId: orderId,
          aggregateVersion: version.rows[0]!.version,
          occurredAt: new Date().toISOString(),
          correlationId: orderId,
          causationId: null,
          payload: { orderId, storeId: task.rows[0].store_id },
        },
        ['dispatch-trigger', 'notifications'],
      );
      const row = await sql<{
        packed_at: Date;
      }>`SELECT packed_at FROM packing_records WHERE order_id=${orderId}::uuid`.execute(tx);
      return { packedAt: row.rows[0]!.packed_at.toISOString() };
    });
  }

  async verified(orderId: string): Promise<boolean> {
    const rows = await sql<{
      one: number;
    }>`SELECT 1 AS one FROM handover_records WHERE order_id=${orderId}::uuid AND state IN ('VERIFIED','OVERRIDE')`.execute(
      this.db,
    );
    return rows.rows.length > 0;
  }

  async issue(
    input: { orderId: string; storeId: string; riderId?: string },
    outer?: TransactionContext,
  ) {
    return this.run(outer, async (tx) => {
      await sql`SELECT id FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(tx);
      const keyVersion = this.runtime.get('PICKING_CODE_KEY_VERSION');
      const secret = fulfillmentCodeKey(this.runtime, keyVersion);
      const verifier = codeVerifier(
        secret,
        input.orderId,
        deriveCode(secret, input.orderId, input.riderId, keyVersion),
      ).toString('hex');
      await sql`INSERT INTO handover_records(id,order_id,store_id,verifier,key_version,rider_id,verifier_format)
        VALUES(${uuidV7()}::uuid,${input.orderId}::uuid,${input.storeId}::uuid,${verifier},${keyVersion},${input.riderId ?? null}::uuid,2)
        ON CONFLICT (order_id) DO UPDATE SET rider_id=EXCLUDED.rider_id,key_version=EXCLUDED.key_version,verifier=EXCLUDED.verifier,
          state='PENDING',attempts=0,locked_until=NULL,verified_at=NULL,verified_by=NULL,override_reason=NULL,verifier_format=2
        WHERE handover_records.rider_id IS DISTINCT FROM EXCLUDED.rider_id`.execute(tx);
      return { state: 'PENDING' as const };
    });
  }

  async presentCode(orderId: string) {
    const rows = await sql<{
      key_version: number;
      rider_id: string | null;
    }>`SELECT key_version,rider_id FROM handover_records WHERE order_id=${orderId}::uuid`.execute(
      this.db,
    );
    if (!rows.rows[0]) throw new Error('HANDOVER_NOT_READY');
    const code = deriveCode(
      fulfillmentCodeKey(this.runtime, rows.rows[0].key_version),
      orderId,
      rows.rows[0].rider_id,
      rows.rows[0].key_version,
    );
    return { code, keyVersion: rows.rows[0].key_version };
  }

  async verify(
    actorId: string,
    input: { orderId: string; code?: string; override?: boolean; reason?: string },
  ) {
    const outcome = await this.run(undefined, async (tx) => {
      const order = await sql<{
        on_hold: boolean;
      }>`SELECT on_hold FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(tx);
      if (order.rows[0]?.on_hold) throw new Error('ORDER_ON_HOLD');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`handover:${input.orderId}`},0))`.execute(
        tx,
      );
      const record = await sql<{
        id: string;
        store_id: string;
        attempts: number;
        locked_until: Date | null;
        state: string;
        key_version: number;
        rider_id: string | null;
        verifier: string;
        verifier_format: number;
      }>`SELECT id,store_id,attempts,locked_until,state,key_version,rider_id,verifier,verifier_format FROM handover_records WHERE order_id=${input.orderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const record_ = record.rows[0];
      if (!record_) throw new Error('HANDOVER_NOT_READY');
      if (!(await this.identity.hasStoreRole(actorId, record_.store_id, ['STORE_MANAGER'], tx)))
        throw new Error('RESOURCE_NOT_FOUND');
      const custody = await sql`SELECT id FROM delivery_tasks WHERE order_id=${input.orderId}::uuid
        AND rider_id IS NOT NULL AND (${record_.rider_id}::uuid IS NULL OR rider_id=${record_.rider_id}::uuid)
        AND status IN ('AT_STORE','PICKED_UP','ARRIVED') FOR UPDATE`.execute(tx);
      if (!custody.rows.length) throw new Error('HANDOVER_NOT_READY');
      if (record_.state === 'VERIFIED' || record_.state === 'OVERRIDE')
        return { state: record_.state as 'VERIFIED' | 'OVERRIDE' };
      const packed =
        await sql`SELECT 1 AS one FROM packing_records WHERE order_id=${input.orderId}::uuid`.execute(
          tx,
        );
      if (!packed.rows.length) throw new Error('HANDOVER_NOT_READY');
      const now = await databaseTimeAfterLock(tx);
      const maxAttempts = await this.config.get('handoverMaxAttempts');
      if (input.override) {
        if (!(await this.identity.hasStoreRole(actorId, record_.store_id, ['STORE_MANAGER'], tx)))
          throw new Error('FORBIDDEN');
        if (!input.reason || input.reason.length > 300) throw new Error('INVALID_INPUT');
        await sql`UPDATE handover_records SET state='OVERRIDE',verified_at=${now.toISOString()}::timestamptz,verified_by=${actorId}::uuid,override_reason=${input.reason} WHERE id=${record_.id}::uuid`.execute(
          tx,
        );
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actorId}::uuid,'picking.handover_override','order',${input.orderId},${JSON.stringify({ reason: input.reason })}::jsonb)`.execute(
          tx,
        );
        return { state: 'OVERRIDE' as const };
      }
      if (
        (record_.locked_until && record_.locked_until > now) ||
        (record_.attempts >= maxAttempts && !record_.locked_until)
      )
        throw new Error('HANDOVER_LOCKED');
      const previousAttempts =
        record_.locked_until && record_.locked_until <= now ? 0 : record_.attempts;
      if (!input.code) throw new Error('HANDOVER_CODE_INVALID');
      const legacyExpected = Buffer.from(
        deriveCode(
          fulfillmentCodeKey(this.runtime, record_.key_version),
          input.orderId,
          record_.rider_id,
          record_.key_version,
        ),
      );
      const presented = Buffer.from(input.code.trim());
      const expected =
        record_.verifier_format === 2 ? Buffer.from(record_.verifier, 'hex') : legacyExpected;
      const supplied =
        record_.verifier_format === 2
          ? codeVerifier(
              fulfillmentCodeKey(this.runtime, record_.key_version),
              input.orderId,
              input.code.trim(),
            )
          : presented;
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        const attempts = previousAttempts + 1;
        const lockout = await this.config.get('handoverLockoutSeconds');
        const locked = attempts >= maxAttempts && lockout > 0;
        await sql`UPDATE handover_records SET attempts=${attempts},locked_until=${locked ? sql`(${now.toISOString()}::timestamptz + ${lockout} * interval '1 second')` : sql`NULL`} WHERE id=${record_.id}::uuid`.execute(
          tx,
        );
        return { error: 'HANDOVER_CODE_INVALID' as const };
      }
      await sql`UPDATE handover_records SET state='VERIFIED',verified_at=${now.toISOString()}::timestamptz,verified_by=${actorId}::uuid WHERE id=${record_.id}::uuid`.execute(
        tx,
      );
      return { state: 'VERIFIED' as const };
    });
    if ('error' in outcome) throw new Error(outcome.error);
    return outcome;
  }
}
