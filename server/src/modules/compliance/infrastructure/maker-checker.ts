import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  type Database,
  type Json,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { ApprovalAction, ApprovalExecutor } from '../contracts/approval.js';
import { canonicalApprovalPayload } from '../domain/approval-policy.js';

function approvalPayloadHash(value: Json): string {
  return createHash('sha256').update(canonicalApprovalPayload(value)).digest('hex');
}

export class MakerChecker implements ApprovalExecutor {
  private readonly actions: Readonly<Record<string, Readonly<ApprovalAction>>>;
  constructor(
    private readonly db: Database,
    actions: Readonly<Record<string, ApprovalAction>>,
  ) {
    // Copy and freeze the registry and policy, preventing later mutation by callers.
    this.actions = Object.freeze(
      Object.fromEntries(
        Object.entries(actions).map(([name, policy]) => [name, Object.freeze({ ...policy })]),
      ),
    );
  }
  async request(makerId: string, actionName: string, payload: Json): Promise<string> {
    const action = this.actions[actionName];
    if (
      !action ||
      !Number.isSafeInteger(action.version) ||
      action.version < 1 ||
      !Number.isSafeInteger(action.ttlSeconds) ||
      action.ttlSeconds < 1 ||
      action.ttlSeconds > 604800 ||
      !action.validate(payload)
    )
      throw new Error('INVALID_APPROVAL');
    const id = uuidV7();
    await this.db.transaction().execute(async (tx) => {
      await this.lockIdentityChanges(tx);
      await this.authorize(tx, makerId, action.makerRole);
      await sql`INSERT INTO maker_checker_requests(id,action,action_version,payload,payload_hash,maker_id,required_role,status,expires_at,execution_key)
        VALUES (${id}::uuid,${actionName},${action.version},${JSON.stringify(payload)}::jsonb,${approvalPayloadHash(payload)},${makerId}::uuid,${action.checkerRole},'PENDING',clock_timestamp()+${action.ttlSeconds}*interval '1 second',${uuidV7()}::uuid)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${makerId}::uuid,'APPROVAL_REQUESTED','approval',${id})`.execute(
        tx,
      );
    });
    return id;
  }
  async approve(checkerId: string, requestId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      // Share the role-change lock before taking user/request row locks to avoid revocation races.
      await this.lockIdentityChanges(tx);
      const result = await sql<{
        maker_id: string;
        action: string;
        action_version: number;
        payload: Json;
        payload_hash: string;
        required_role: string;
        status: string;
        expires_at: Date;
        execution_key: string;
      }>`SELECT maker_id,action,action_version,payload,payload_hash,required_role,status,expires_at,execution_key FROM maker_checker_requests WHERE id=${requestId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const row = result.rows[0];
      const now = await databaseTimeAfterLock(tx);
      if (
        !row ||
        row.status !== 'PENDING' ||
        row.expires_at <= now ||
        row.payload_hash !== approvalPayloadHash(row.payload)
      )
        throw new Error('APPROVAL_INVALID');
      const action = this.actions[row.action];
      if (
        !action ||
        action.version !== row.action_version ||
        action.checkerRole !== row.required_role ||
        !action.validate(row.payload)
      )
        throw new Error('APPROVAL_POLICY_CHANGED');
      const singlePerson = row.maker_id === checkerId;
      if (
        singlePerson &&
        (action.makerRole !== action.checkerRole ||
          !['SUPER_ADMIN', 'STORE_MANAGER'].includes(action.checkerRole))
      )
        throw new Error('APPROVAL_INVALID');
      await this.authorize(tx, row.maker_id, action.makerRole);
      await this.authorize(tx, checkerId, action.checkerRole);
      await action.execute(tx, row.payload, row.execution_key, checkerId);
      await sql`UPDATE maker_checker_requests SET status='EXECUTED',checker_id=${checkerId}::uuid,executed_at=clock_timestamp() WHERE id=${requestId}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${checkerId}::uuid,'APPROVAL_EXECUTED','approval',${requestId},${JSON.stringify({ singlePerson })}::jsonb)`.execute(
        tx,
      );
    });
  }
  private async lockIdentityChanges(tx: TransactionContext): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(701002)`.execute(tx);
  }
  private async authorize(tx: TransactionContext, actorId: string, role: string): Promise<void> {
    const allowed = await sql<{
      id: string;
    }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role=${role} FOR SHARE OF u,r`.execute(
      tx,
    );
    if (!allowed.rows[0]) throw new Error('FORBIDDEN');
  }
}
