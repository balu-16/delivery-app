import { fulfillmentCodeKey } from '../../../common/ids/fulfillment-code-keys.js';
import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { ConfigService } from '../../../config/config.service.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { deriveCode, deriveVerifier, verifiersMatch } from './code-crypto.js';
import { uuidV7 } from '../../../common/ids/ids.js';

/**
 * Delivery codes (D20/ADD-15). The code is derived with a versioned secret
 * and the order-specific nonce (`delivery-code:v{version}:{orderId}`); only
 * the HMAC verifier (a second, separately derived key) and the key version
 * are persisted, never the plaintext code. Re-derivation for authorized
 * customer reads is deterministic across process restarts and key rotation
 * keeps historical verifiers working. Attempt limits persist in the verifier
 * row and lock it out at the configured attempt limit. Domain separation from the
 * P7 handover code is deliberate: same env secret root, disjoint derived
 * keys and labels.
 */
export class OrderCodeService {
  constructor(
    private readonly db: Database,
    private readonly runtime: ConfigService,
    private readonly config: AppConfig,
  ) {}
  private derive(orderId: string, version: number): string {
    return deriveCode(fulfillmentCodeKey(this.runtime, version), orderId, version);
  }
  private verifier(orderId: string, version: number): Buffer {
    return deriveVerifier(
      fulfillmentCodeKey(this.runtime, version),
      orderId,
      this.derive(orderId, version),
      version,
    );
  }
  /** Called at confirmation inside the placement/confirmation transaction. */
  async issueFor(tx: TransactionContext, orderId: string): Promise<void> {
    const version = this.runtime.get('PICKING_CODE_KEY_VERSION');
    await sql`INSERT INTO order_code_verifiers(id,order_id,verifier,key_version)
      VALUES (gen_random_uuid(),${orderId}::uuid,${this.verifier(orderId, version)},${version})
      ON CONFLICT (order_id) DO NOTHING`.execute(tx);
  }
  async issue(orderId: string, tx?: TransactionContext) {
    if (tx) await this.issueFor(tx, orderId);
    else await this.db.transaction().execute((ctx) => this.issueFor(ctx, orderId));
  }
  /** Authorized customer read: re-derive from the versioned secret. */
  async present(orderId: string, userId: string): Promise<{ code: string; keyVersion: number }> {
    const rows = await sql<{
      user_id: string;
      key_version: number;
    }>`SELECT o.user_id,c.key_version FROM orders o JOIN order_code_verifiers c ON c.order_id=o.id
      WHERE o.id=${orderId}::uuid`.execute(this.db);
    if (rows.rows[0]?.user_id !== userId) throw new Error('ORDER_NOT_FOUND');
    const version = rows.rows[0].key_version;
    return { code: this.derive(orderId, version), keyVersion: version };
  }
  /** Attempt-limited verification used by the P8 delivery task. */
  async verify(orderId: string, code: string, tx?: TransactionContext): Promise<boolean> {
    const run = async (tx: TransactionContext): Promise<boolean> => {
      const rows = await sql<{
        verifier: Buffer;
        key_version: number;
        attempt_count: number;
        locked_at: Date | null;
      }>`SELECT verifier,key_version,attempt_count,locked_at FROM order_code_verifiers
        WHERE order_id=${orderId}::uuid FOR UPDATE`.execute(tx);
      const row = rows.rows[0];
      if (!row) return false;
      const maximum = await this.config.get('deliveryCodeMaxAttempts');
      if (row.locked_at || row.attempt_count >= maximum) throw new Error('DELIVERY_CODE_LOCKED');
      const expected = Buffer.from(row.verifier);
      const provided = deriveVerifier(
        fulfillmentCodeKey(this.runtime, row.key_version),
        orderId,
        code,
        row.key_version,
      );
      const ok = /^\d{4}$/.test(code) && verifiersMatch(expected, provided);
      if (ok) return true;
      const locked = row.attempt_count + 1 >= maximum;
      await sql`UPDATE order_code_verifiers SET attempt_count=attempt_count+1,
        locked_at=CASE WHEN ${locked} THEN clock_timestamp() ELSE locked_at END
        WHERE order_id=${orderId}::uuid`.execute(tx);
      return false;
    };
    return tx ? run(tx) : this.db.transaction().execute(run);
  }
  /** Reset only the verifier lock for an active delivery; proof is still required. */
  async resetLock(orderId: string, adminId: string, reason: string): Promise<void> {
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 300) throw new Error('INVALID_INPUT');
    await this.db.transaction().execute(async (tx) => {
      const admin = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.id=${adminId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE'
          AND r.role IN ('ADMIN','SUPER_ADMIN') FOR SHARE OF u,r`.execute(tx);
      if (!admin.rows.length) throw new Error('FORBIDDEN');
      const order = await sql<{
        status: string;
      }>`SELECT status FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
      if (!order.rows[0]) throw new Error('ORDER_NOT_FOUND');
      if (order.rows[0].status !== 'OUT_FOR_DELIVERY') throw new Error('ILLEGAL_STATE_TRANSITION');
      const custody = await sql`SELECT id FROM delivery_tasks WHERE order_id=${orderId}::uuid
        AND status IN ('PICKED_UP','ARRIVED') AND rider_id IS NOT NULL AND custody_released_at IS NULL FOR UPDATE`.execute(
        tx,
      );
      if (!custody.rows.length) throw new Error('ILLEGAL_STATE_TRANSITION');
      const reset = await sql`UPDATE order_code_verifiers SET attempt_count=0,locked_at=NULL
        WHERE order_id=${orderId}::uuid RETURNING id`.execute(tx);
      if (!reset.rows.length) throw new Error('ORDER_NOT_FOUND');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES(${uuidV7()}::uuid,${adminId}::uuid,'DELIVERY_CODE_LOCK_RESET','order',${orderId},${JSON.stringify({ reason: trimmed })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
