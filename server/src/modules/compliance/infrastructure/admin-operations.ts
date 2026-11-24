import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';

/** A maker may withdraw their own pending catalog price/import via the same audited reject flow. */
export function isCatalogSelfWithdrawable(action: string): boolean {
  return [
    'CATALOG_PRICE_CHANGE',
    'CATALOG_PRICE_CHANGE_SUPER',
    'CATALOG_IMPORT',
    'CATALOG_IMPORT_SUPER',
  ].includes(action);
}

/** Administrative reviews change review state only; no money or order side effects. */
export class AdminComplianceOperations {
  constructor(private readonly db: Database) {}
  /** Server-side decision capability for one approval row as the acting admin sees it. */
  private static capabilities(
    row: {
      maker_id: string;
      required_role: string;
      status: string;
      expires_at: Date;
      action?: string;
    },
    actorId: string | undefined,
    isAdmin: boolean,
    now: Date,
  ): { canApprove: boolean; canReject: boolean; cannotApproveReason: string | null } {
    const isOwn = actorId !== undefined && row.maker_id === actorId;
    const selfWithdrawable = isOwn && isCatalogSelfWithdrawable(row.action ?? '');
    const reason =
      row.status !== 'PENDING'
        ? `Already ${row.status}`
        : row.expires_at <= now
          ? 'Approval expired'
          : !isAdmin
            ? 'Requires SUPER_ADMIN'
            : isOwn && !selfWithdrawable
              ? 'Maker cannot decide their own request'
              : null;
    const allowed = reason === null;
    return {
      canApprove: allowed && !selfWithdrawable,
      canReject: allowed,
      cannotApproveReason: allowed ? null : reason,
    };
  }

  private async isSuperAdmin(actorId: string | undefined): Promise<boolean> {
    if (!actorId) return false;
    const role = await sql<{
      ok: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.status='ACTIVE' AND r.role='SUPER_ADMIN') AS ok`.execute(
      this.db,
    );
    return role.rows[0]?.ok === true;
  }

  async list(
    kind: 'fraud' | 'reconciliation' | 'approval',
    cursor: string | undefined,
    limit: number,
    actorId?: string,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const result =
      kind === 'fraud'
        ? await sql<{
            id: string;
          }>`SELECT id,kind,severity,status,created_at FROM fraud_signals WHERE (${cursor ?? null}::uuid IS NULL OR id < ${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
            this.db,
          )
        : kind === 'reconciliation'
          ? await sql<{
              id: string;
            }>`SELECT id,kind,severity,status,aggregate_type,aggregate_id,created_at FROM reconciliation_findings WHERE (${cursor ?? null}::uuid IS NULL OR id < ${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
              this.db,
            )
          : await sql<{
              id: string;
              maker_id: string;
              required_role: string;
              status: string;
              expires_at: Date;
            }>`SELECT id,action,maker_id,checker_id,required_role,status,expires_at,created_at FROM maker_checker_requests WHERE (${cursor ?? null}::uuid IS NULL OR id < ${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
              this.db,
            );
    const rows = result.rows.slice(0, limit);
    let items: unknown[] = rows;
    if (kind === 'approval') {
      const [isAdmin, now] = await Promise.all([
        this.isSuperAdmin(actorId),
        sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(this.db),
      ]);
      const asOf = now.rows[0]?.now ?? new Date();
      items = (
        rows as unknown as Array<{
          maker_id: string;
          required_role: string;
          status: string;
          expires_at: Date;
        }>
      ).map((row) => ({
        ...row,
        ...AdminComplianceOperations.capabilities(row, actorId, isAdmin, asOf),
      }));
    }
    return {
      items,
      nextCursor: result.rows.length > limit ? (rows.at(-1)?.id ?? null) : null,
    };
  }
  async detail(kind: 'fraud' | 'reconciliation' | 'approval', id: string, actorId?: string) {
    const result =
      kind === 'fraud'
        ? await sql`SELECT id,user_id,kind,severity,reference,details,status,created_at,reviewed_by,reviewed_at FROM fraud_signals WHERE id=${id}::uuid`.execute(
            this.db,
          )
        : kind === 'reconciliation'
          ? await sql`SELECT id,kind,severity,aggregate_type,aggregate_id,reference,details,status,resolved_by,resolved_at,created_at FROM reconciliation_findings WHERE id=${id}::uuid`.execute(
              this.db,
            )
          : await sql`SELECT id,action,action_version,maker_id,checker_id,required_role,status,expires_at,created_at,executed_at FROM maker_checker_requests WHERE id=${id}::uuid`.execute(
              this.db,
            );
    if (!result.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    if (kind !== 'approval') return result.rows[0];
    const [isAdmin, now] = await Promise.all([
      this.isSuperAdmin(actorId),
      sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(this.db),
    ]);
    const row = result.rows[0] as {
      maker_id: string;
      required_role: string;
      status: string;
      expires_at: Date;
    };
    return {
      ...row,
      ...AdminComplianceOperations.capabilities(
        row,
        actorId,
        isAdmin,
        now.rows[0]?.now ?? new Date(),
      ),
    };
  }
  async review(
    kind: 'fraud' | 'reconciliation' | 'approval',
    id: string,
    actor: string,
    decision: string,
    reason: string,
  ) {
    if (!reason.trim() || reason.length > 300) throw new Error('INVALID_REASON');
    const allowed =
      kind === 'fraud'
        ? ['ACKNOWLEDGED', 'DISMISSED', 'ESCALATED']
        : kind === 'reconciliation'
          ? ['RESOLVED', 'DISMISSED']
          : ['REJECTED'];
    if (!allowed.includes(decision)) throw new Error('INVALID_DECISION');
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(701002)`.execute(tx);
      const role = await sql<{
        ok: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actor}::uuid AND u.status='ACTIVE' AND r.role='SUPER_ADMIN') AS ok`.execute(
        tx,
      );
      if (!role.rows[0]?.ok) throw new Error('FORBIDDEN');
      const changed =
        kind === 'fraud'
          ? await sql`UPDATE fraud_signals SET status='REVIEWED',reviewed_by=${actor}::uuid,reviewed_at=clock_timestamp() WHERE id=${id}::uuid AND status='OPEN' RETURNING id`.execute(
              tx,
            )
          : kind === 'reconciliation'
            ? await sql`UPDATE reconciliation_findings SET status=${decision},resolved_by=${actor}::uuid,resolved_at=clock_timestamp() WHERE id=${id}::uuid AND status='OPEN' RETURNING id`.execute(
                tx,
              )
            : await sql`UPDATE maker_checker_requests SET status='REJECTED',checker_id=${actor}::uuid WHERE id=${id}::uuid AND status='PENDING' AND expires_at>clock_timestamp() AND (maker_id<>${actor}::uuid OR action IN ('CATALOG_PRICE_CHANGE','CATALOG_PRICE_CHANGE_SUPER','CATALOG_IMPORT','CATALOG_IMPORT_SUPER')) RETURNING id,action,execution_key,payload`.execute(
                tx,
              );
      if (!changed.rows.length) throw new Error('RESOURCE_CONFLICT');
      // A rejected pending catalog import reaches a terminal FAILED job with the
      // rejection reason in the SAME transaction, so the worker never
      // re-requests approval for it. Errors, fingerprint and report are kept.
      if (kind === 'approval' && changed.rows.length) {
        const rejected = changed.rows[0] as {
          id: string;
          action: string;
          execution_key: string;
          payload: { jobId?: string; fingerprint?: string };
        };
        if (rejected.action === 'CATALOG_IMPORT' || rejected.action === 'CATALOG_IMPORT_SUPER') {
          const jobId = rejected.payload?.jobId;
          if (typeof jobId === 'string') {
            await sql`UPDATE catalog_import_jobs SET status='FAILED',rejection_reason=${reason.trim()},lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${jobId}::uuid AND status='AWAITING_APPROVAL' AND approval_id=${id}::uuid`.execute(
              tx,
            );
          }
        }
      }
      const category =
        kind === 'fraud' ? 'FRAUD' : kind === 'reconciliation' ? 'RECONCILIATION' : 'APPROVAL';
      await sql`INSERT INTO compliance_reviews(id,kind,subject_id,actor_id,decision,reason) VALUES (${uuidV7()}::uuid,${category},${id}::uuid,${actor}::uuid,${decision},${reason.trim()})`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actor}::uuid,'COMPLIANCE_REVIEW',${kind},${id},${JSON.stringify({ decision })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
