import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Json } from '../../../platform/database/database.js';
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
 * Manual money moves (Section 24.5): maker-checker through the shared
 * approval executor (maker ADMIN, checker SUPER_ADMIN, different users); the
 * approval execution key is the wallet ledger reference, so the approved
 * adjustment applies exactly once even if approval retries. Every execution
 * writes an audit row; the adjustment itself debits cannot go negative.
 */
export class WalletAdjustmentService implements WalletAdjustments {
  private readonly executor: ApprovalExecutor;
  constructor(
    primitives: WalletPrimitives,
    spender: WalletSpender,
    approvalFactory: (actions: Record<string, ApprovalAction>) => ApprovalExecutor,
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
  request(makerId: string, input: WalletAdjustmentRequest): Promise<string> {
    return this.executor.request(makerId, ADJUSTMENT_ACTION, payloadOf(input));
  }
  approve(checkerId: string, requestId: string): Promise<void> {
    return this.executor.approve(checkerId, requestId);
  }
}
