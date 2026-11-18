import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Json } from '../../../platform/database/database.js';
import type { Database } from '../../../platform/database/database.js';
import { hashCanonical } from '../../../common/idempotency/idempotency.js';
import type { ApprovalAction, ApprovalExecutor } from '../../compliance/contracts/approval.js';
import { parseMoney } from '../../../common/money/money.js';
import type {
  WalletAdjustmentRequest,
  WalletAdjustments,
  WalletSpender,
} from '../contracts/wallet.js';
import { WalletPrimitives } from './postgres-wallet.js';

const ADJUSTMENT_ACTION = 'walletAdjustment';
export const WALLET_ADJUSTMENT_TTL_SECONDS = 86400;

function payloadOf(input: WalletAdjustmentRequest): Json {
  return {
    userId: input.userId,
    bucket: input.bucket,
    direction: input.direction,
    amountPaise: input.amountPaise,
    reason: input.reason,
  };
}
function validRequest(payload: Json): boolean {
  const body = payload as unknown as WalletAdjustmentRequest;
  if (
    typeof body.userId !== 'string' ||
    !/^[0-9a-fA-F-]{36}$/.test(body.userId) ||
    (body.bucket !== 'cash' && body.bucket !== 'promo') ||
    (body.direction !== 'CREDIT' && body.direction !== 'DEBIT') ||
    typeof body.amountPaise !== 'string' ||
    typeof body.reason !== 'string' ||
    body.reason.length === 0 ||
    body.reason.length > 200
  )
    return false;
  try {
    return parseMoney(body.amountPaise) > 0n;
  } catch {
    return false;
  }
}

/**
 * Manual money moves use the shared approval executor; the same SUPER_ADMIN
 * may request and confirm. The approval execution key is the ledger reference, so the approved
 * adjustment applies exactly once even if approval retries. Every execution
 * writes an audit row; debits cannot take the balance below zero.
 */
export class WalletAdjustmentService implements WalletAdjustments {
  private readonly executor: ApprovalExecutor;
  constructor(
    primitives: WalletPrimitives,
    spender: WalletSpender,
    approvalFactory: (actions: Record<string, ApprovalAction>) => ApprovalExecutor,
    private readonly db?: Database,
  ) {
    this.executor = approvalFactory({
      [ADJUSTMENT_ACTION]: {
        version: 1,
        makerRole: 'SUPER_ADMIN',
        checkerRole: 'SUPER_ADMIN',
        ttlSeconds: WALLET_ADJUSTMENT_TTL_SECONDS,
        validate: (payload) => validRequest(payload),
        async execute(tx, payload, executionKey, checkerId) {
          const body = payload as unknown as WalletAdjustmentRequest;
          const delta = (body.direction === 'CREDIT' ? 1n : -1n) * parseMoney(body.amountPaise);
          await spender.adjust({
            userId: body.userId,
            bucket: body.bucket,
            deltaPaise: delta.toString(),
            refId: executionKey,
            tx,
          });
          await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
            VALUES (${uuidV7()}::uuid,${checkerId}::uuid,'WALLET_ADJUSTED','wallet_account',${body.userId},
              ${JSON.stringify({ bucket: body.bucket, deltaPaise: delta.toString(), reason: body.reason, executionKey })}::jsonb)`.execute(
            tx,
          );
        },
      } satisfies ApprovalAction,
    });
  }
  async request(
    makerId: string,
    input: WalletAdjustmentRequest,
    clientRequestId?: string,
  ): Promise<string> {
    if (!clientRequestId)
      return this.executor.request(makerId, ADJUSTMENT_ACTION, payloadOf(input));
    if (!this.db || !/^[\x21-\x7e]{1,150}$/.test(clientRequestId)) throw new Error('INVALID_INPUT');
    const actor =
      await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${makerId}::uuid AND u.status='ACTIVE' AND u.pool='WORKFORCE' AND r.role='SUPER_ADMIN'`.execute(
        this.db,
      );
    if (!actor.rows.length) throw new Error('FORBIDDEN');
    const payload = { ...(payloadOf(input) as Record<string, Json>), clientRequestId };
    const existing = async () => {
      const row = await sql<{
        id: string;
        payload: Json;
      }>`SELECT id::text,payload FROM maker_checker_requests WHERE maker_id=${makerId}::uuid AND action='walletAdjustment' AND payload->>'clientRequestId'=${clientRequestId}`.execute(
        this.db!,
      );
      if (!row.rows[0]) return null;
      if (hashCanonical(row.rows[0].payload) !== hashCanonical(payload))
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      return row.rows[0].id;
    };
    const prior = await existing();
    if (prior) return prior;
    try {
      return await this.executor.request(makerId, ADJUSTMENT_ACTION, payload);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        const raced = await existing();
        if (raced) return raced;
      }
      throw error;
    }
  }
  async approve(checkerId: string, requestId: string): Promise<void> {
    try {
      await this.executor.approve(checkerId, requestId);
    } catch (error) {
      if (this.db && error instanceof Error && error.message === 'APPROVAL_INVALID') {
        const result = await sql<{
          status: string;
          expired: boolean;
        }>`SELECT m.status,m.expires_at<=clock_timestamp() AS expired
          FROM maker_checker_requests m JOIN users u ON u.id=${checkerId}::uuid JOIN user_roles r ON r.user_id=u.id
          WHERE m.id=${requestId}::uuid AND m.action='walletAdjustment' AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='SUPER_ADMIN'`.execute(
          this.db,
        );
        const prior = result.rows[0];
        if (prior?.status === 'EXECUTED') return;
        // An expired pending approval cannot execute later, so the client may
        // safely start a new, explicitly confirmed request with a fresh key.
        if (prior?.status === 'EXPIRED' || (prior?.status === 'PENDING' && prior.expired))
          throw new Error('APPROVAL_EXPIRED', { cause: error });
      }
      throw error;
    }
  }
}
