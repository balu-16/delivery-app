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
import type { HandoverCodes, PackInput, PickPacking } from '../contracts/packing.js';
import { operation } from './pick-primitives.js';

function deriveCode(secret: string, orderId: string): string {
  const digest = createHmac('sha256', secret).update(`handover:v1:${orderId}`).digest();
  return String(digest.readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
}

/** Packing records and handover verification; the derived code is never stored. */
export class PostgresPacking implements PickPacking, HandoverCodes {
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
      const task = await sql<{
        id: string;
        store_id: string;
      }>`SELECT id,store_id FROM pick_tasks WHERE order_id=${orderId}::uuid AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`.execute(
        tx,
      );
      if (!task.rows[0]) throw new Error('PICK_TASK_NOT_COMPLETE');
      if (
        !(await this.identity.hasStoreRole(
          actorId,
          task.rows[0].store_id,
          ['PICKER', 'STORE_MANAGER'],
          tx,
        ))
      )
        throw new Error('RESOURCE_NOT_FOUND');
      if (!(await operation(tx, `pack:${orderId}:${reference}`, 'PACK', { orderId, input }))) {
        const existing = await sql<{
          packed_at: Date;
        }>`SELECT packed_at FROM packing_records WHERE order_id=${orderId}::uuid`.execute(tx);
        return { packedAt: existing.rows[0]!.packed_at.toISOString() };
      }
      await sql`INSERT INTO packing_records(order_id,task_id,store_id,bags,seal_code,cold_chain,packed_by) VALUES(${orderId}::uuid,${task.rows[0].id}::uuid,${task.rows[0].store_id}::uuid,${bags},${input.sealCode},${input.coldChain},${actorId}::uuid) ON CONFLICT (order_id) DO NOTHING`.execute(
        tx,
      );
      await this.fulfillment.markPacked(orderId, actorId, tx);
      const row = await sql<{
        packed_at: Date;
      }>`SELECT packed_at FROM packing_records WHERE order_id=${orderId}::uuid`.execute(tx);
      return { packedAt: row.rows[0]!.packed_at.toISOString() };
    });
  }

  async issue(input: { orderId: string; storeId: string }) {
    return this.run(undefined, async (tx) => {
      const secret = this.runtime.get('PICKING_HANDOVER_SECRET');
      const verifier = createHmac('sha256', secret)
        .update(`handover:v1:${input.orderId}`)
        .digest('hex');
      await sql`INSERT INTO handover_records(id,order_id,store_id,verifier) VALUES(${uuidV7()}::uuid,${input.orderId}::uuid,${input.storeId}::uuid,${verifier}) ON CONFLICT (order_id) DO NOTHING`.execute(
        tx,
      );
      return { state: 'PENDING' as const };
    });
  }

  async presentCode(orderId: string) {
    const rows = await sql<{
      key_version: number;
    }>`SELECT key_version FROM handover_records WHERE order_id=${orderId}::uuid`.execute(this.db);
    if (!rows.rows[0]) throw new Error('HANDOVER_NOT_READY');
    const code = deriveCode(this.runtime.get('PICKING_HANDOVER_SECRET'), orderId);
    return { code, keyVersion: rows.rows[0].key_version };
  }

  async verify(
    actorId: string,
    input: { orderId: string; code?: string; override?: boolean; reason?: string },
  ) {
    return this.run(undefined, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`handover:${input.orderId}`},0))`.execute(
        tx,
      );
      const record = await sql<{
        id: string;
        store_id: string;
        attempts: number;
        locked_until: Date | null;
        state: string;
      }>`SELECT id,store_id,attempts,locked_until,state FROM handover_records WHERE order_id=${input.orderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const record_ = record.rows[0];
      if (!record_) throw new Error('HANDOVER_NOT_READY');
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
      if (record_.attempts >= maxAttempts || (record_.locked_until && record_.locked_until > now))
        throw new Error('HANDOVER_LOCKED');
      if (!input.code) throw new Error('HANDOVER_CODE_INVALID');
      const expected = Buffer.from(
        deriveCode(this.runtime.get('PICKING_HANDOVER_SECRET'), input.orderId),
      );
      const presented = Buffer.from(input.code.trim());
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        const attempts = record_.attempts + 1;
        const lockout = await this.config.get('handoverLockoutSeconds');
        const locked = attempts >= maxAttempts && lockout > 0;
        await sql`UPDATE handover_records SET attempts=${attempts}${locked ? sql`,locked_until=(${now.toISOString()}::timestamptz + ${lockout} * interval '1 second')` : sql``} WHERE id=${record_.id}::uuid`.execute(
          tx,
        );
        throw new Error('HANDOVER_CODE_INVALID');
      }
      await sql`UPDATE handover_records SET state='VERIFIED',verified_at=${now.toISOString()}::timestamptz,verified_by=${actorId}::uuid WHERE id=${record_.id}::uuid`.execute(
        tx,
      );
      return { state: 'VERIFIED' as const };
    });
  }
}
