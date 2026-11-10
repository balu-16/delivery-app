import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json } from '../../../platform/database/database.js';
import type { ApprovalExecutor, ApprovalFactory } from '../contracts/approval.js';
import type { PrivacyOperations } from '../contracts/privacy.js';

export class PrivacyRequests implements PrivacyOperations {
  private readonly approvals: ApprovalExecutor;
  constructor(
    private readonly db: Database,
    factory: ApprovalFactory,
  ) {
    this.approvals = factory.create({
      'identity.erasure': {
        version: 1,
        makerRole: 'SUPER_ADMIN',
        checkerRole: 'SUPER_ADMIN',
        ttlSeconds: 86400,
        validate(payload: Json) {
          return (
            !!payload &&
            typeof payload === 'object' &&
            !Array.isArray(payload) &&
            Object.keys(payload).join(',') === 'userId' &&
            typeof payload.userId === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.userId)
          );
        },
        async execute(tx, payload, _key, checker) {
          const userId = (payload as { userId: string }).userId;
          if (userId === checker) throw new Error('CANNOT_ERASE_SELF');
          const target = await sql<{
            pool: string;
            status: string;
          }>`SELECT pool,status FROM users WHERE id=${userId}::uuid FOR UPDATE`.execute(tx);
          if (target.rows[0]?.pool !== 'WORKFORCE' || target.rows[0].status !== 'ACTIVE')
            throw new Error('RESOURCE_NOT_FOUND');
          const lastSuper = await sql<{
            protected: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=${userId}::uuid AND role='SUPER_ADMIN') AND (SELECT count(*) FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.status='ACTIVE' AND r.role='SUPER_ADMIN') <= 1 AS protected`.execute(
            tx,
          );
          if (lastSuper.rows[0]?.protected) throw new Error('LAST_SUPER_ADMIN');
          await sql`INSERT INTO erasure_requests(id,user_id,status,approved_by) VALUES (${uuidV7()}::uuid,${userId}::uuid,'REQUESTED',${checker}::uuid) ON CONFLICT (user_id) WHERE status IN ('REQUESTED','BLOCKED','AWAITING_APPROVAL','PROCESSING','CLEANUP') DO NOTHING`.execute(
            tx,
          );
        },
      },
    });
  }
  async requestWorkforce(actorId: string, userId: string): Promise<string> {
    if (actorId === userId) throw new Error('CANNOT_ERASE_SELF');
    const target = await sql<{
      pool: string;
      status: string;
    }>`SELECT pool,status FROM users WHERE id=${userId}::uuid`.execute(this.db);
    if (target.rows[0]?.pool !== 'WORKFORCE' || target.rows[0].status !== 'ACTIVE')
      throw new Error('RESOURCE_NOT_FOUND');
    return this.approvals.request(actorId, 'identity.erasure', { userId });
  }
  approveWorkforce(actorId: string, approvalId: string): Promise<void> {
    return this.approvals.approve(actorId, approvalId);
  }
  async statusForCustomer(userId: string) {
    return (
      (
        await sql`SELECT id,status,blockers,created_at,updated_at FROM erasure_requests WHERE user_id=${userId}::uuid ORDER BY created_at DESC,id DESC LIMIT 1`.execute(
          this.db,
        )
      ).rows[0] ?? null
    );
  }
  async adminStatus(requestId: string) {
    const row = (
      await sql`SELECT id,user_id,status,blockers,created_at,updated_at FROM erasure_requests WHERE id=${requestId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    return row;
  }
  async adminList(cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const result = await sql<{
      id: string;
    }>`SELECT id,user_id,status,blockers,created_at,updated_at FROM erasure_requests WHERE (${cursor ?? null}::uuid IS NULL OR id<${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
      this.db,
    );
    const items = result.rows.slice(0, limit);
    return { items, nextCursor: result.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }
  async retry(actorId: string, requestId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row =
        await sql`UPDATE erasure_requests SET retry_after=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${requestId}::uuid AND status IN ('BLOCKED','REQUESTED','CLEANUP') RETURNING id`.execute(
          tx,
        );
      if (!row.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'ERASURE_RETRY','erasure_request',${requestId})`.execute(
        tx,
      );
    });
  }
  async createHold(actorId: string, userId: string, reason: string): Promise<string> {
    if (!reason.trim() || reason.length > 300) throw new Error('INVALID_REASON');
    return this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      const id = uuidV7();
      await sql`INSERT INTO privacy_legal_holds(id,user_id,reason,created_by) VALUES (${id}::uuid,${userId}::uuid,${reason.trim()},${actorId}::uuid)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'LEGAL_HOLD_CREATED','legal_hold',${id})`.execute(
        tx,
      );
      return id;
    });
  }
  async releaseHold(actorId: string, holdId: string, reason: string): Promise<void> {
    if (!reason.trim() || reason.length > 300) throw new Error('INVALID_REASON');
    await this.db.transaction().execute(async (tx) => {
      const result =
        await sql`UPDATE privacy_legal_holds SET released_at=clock_timestamp() WHERE id=${holdId}::uuid AND released_at IS NULL RETURNING id`.execute(
          tx,
        );
      if (!result.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'LEGAL_HOLD_RELEASED','legal_hold',${holdId},${JSON.stringify({ reason: reason.trim() })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
