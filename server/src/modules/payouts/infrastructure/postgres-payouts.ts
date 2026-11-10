import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { lockActiveAccount } from '../../identity/contracts/account-lock.js';
import {
  transactionWithRetry,
  databaseTimeAfterLock,
  type Database,
  type Json,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { ApprovalExecutor, ApprovalFactory } from '../../compliance/contracts/approval.js';
import type { Payouts } from '../contracts/payouts.js';

interface PayoutRow {
  id: string;
  rider_id: string;
  state: string;
  version: string;
  gross_paise: string;
  cash_offset_paise: string;
  net_paise: string;
  payment_request_hash: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authorize(tx: TransactionContext, actor: string): Promise<void> {
  const result =
    await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actor}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('ADMIN','SUPER_ADMIN') FOR SHARE OF u,r`.execute(
      tx,
    );
  if (!result.rows.length) throw new Error('FORBIDDEN');
}
async function lockRider(tx: TransactionContext, riderId: string): Promise<void> {
  await sql`INSERT INTO rider_status(rider_id) VALUES (${riderId}::uuid) ON CONFLICT DO NOTHING`.execute(
    tx,
  );
  await sql`SELECT rider_id FROM rider_status WHERE rider_id=${riderId}::uuid FOR UPDATE`.execute(
    tx,
  );
}
async function due(tx: TransactionContext, riderId: string): Promise<bigint> {
  const row = await sql<{
    balance_after: string;
  }>`SELECT balance_after::text FROM rider_cash_ledger WHERE rider_id=${riderId}::uuid ORDER BY created_at DESC,id DESC LIMIT 1`.execute(
    tx,
  );
  return BigInt(row.rows[0]?.balance_after ?? '0');
}
async function lockPayout(tx: TransactionContext, id: string): Promise<PayoutRow> {
  const row =
    await sql<PayoutRow>`SELECT id,rider_id,state,version::text,gross_paise::text,cash_offset_paise::text,net_paise::text,payment_request_hash FROM rider_payouts WHERE id=${id}::uuid FOR UPDATE`.execute(
      tx,
    );
  if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
  return row.rows[0];
}
async function riderFor(tx: TransactionContext, id: string): Promise<string> {
  const row = await sql<{
    rider_id: string;
  }>`SELECT rider_id FROM rider_payouts WHERE id=${id}::uuid`.execute(tx);
  if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
  return row.rows[0].rider_id;
}
export class PostgresPayouts implements Payouts {
  private readonly approval: ApprovalExecutor;
  constructor(
    private readonly db: Database,
    factory: ApprovalFactory,
  ) {
    this.approval = factory.create({
      payout: {
        version: 1,
        makerRole: 'ADMIN',
        checkerRole: 'SUPER_ADMIN',
        ttlSeconds: 86400,
        validate: (payload: Json) => {
          const p = payload as { id?: unknown; version?: unknown };
          return (
            typeof p?.id === 'string' &&
            uuid.test(p.id) &&
            typeof p.version === 'string' &&
            /^\d+$/.test(p.version)
          );
        },
        execute: async (tx, payload, _key, checker) => {
          const p = payload as { id: string; version: string };
          const rider = await riderFor(tx, p.id);
          await lockRider(tx, rider);
          const payout = await lockPayout(tx, p.id);
          if (payout.state !== 'DRAFT' || payout.version !== p.version)
            throw new Error('PAYOUT_STALE');
          const balance = await due(tx, rider),
            gross = BigInt(payout.gross_paise);
          const offset = balance < gross ? balance : gross;
          if (offset !== BigInt(payout.cash_offset_paise)) throw new Error('PAYOUT_STALE');
          const earnings = await sql<{
            sum: string;
            count: string;
          }>`SELECT COALESCE(SUM(e.total_paise),0)::text AS sum, COUNT(*)::text AS count FROM payout_earning_claims c JOIN rider_earnings e ON e.id=c.earning_id WHERE c.payout_id=${p.id}::uuid AND c.active AND e.rider_id=${rider}::uuid AND e.payout_reference IS NULL`.execute(
            tx,
          );
          if (
            !earnings.rows[0] ||
            earnings.rows[0].sum !== payout.gross_paise ||
            earnings.rows[0].count === '0'
          )
            throw new Error('PAYOUT_STALE');
          if (offset > 0n)
            await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after) VALUES(${uuidV7()}::uuid,${rider}::uuid,${(-offset).toString()}::bigint,'ADJUSTMENT','payout_offset',${p.id},${(balance - offset).toString()}::bigint)`.execute(
              tx,
            );
          await sql`UPDATE rider_earnings SET payout_reference=${p.id} WHERE id IN (SELECT earning_id FROM payout_earning_claims WHERE payout_id=${p.id}::uuid AND active) AND payout_reference IS NULL`.execute(
            tx,
          );
          const zero = payout.net_paise === '0';
          await sql`UPDATE rider_payouts SET state=${zero ? 'SETTLED_ZERO' : 'APPROVED'},payment_reference=${zero ? `zero:${p.id}` : null},approved_at=clock_timestamp(),paid_at=CASE WHEN ${zero} THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE id=${p.id}::uuid`.execute(
            tx,
          );
          await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${checker}::uuid,'payout.approved','rider_payout',${p.id},${JSON.stringify({ offsetPaise: offset.toString() })}::jsonb)`.execute(
            tx,
          );
        },
      },
      payoutCorrection: {
        version: 1,
        makerRole: 'ADMIN',
        checkerRole: 'SUPER_ADMIN',
        ttlSeconds: 86400,
        validate: (payload: Json) => {
          const p = payload as {
            payoutId?: unknown;
            deltaPaise?: unknown;
            reason?: unknown;
            reference?: unknown;
            makerId?: unknown;
          };
          return (
            typeof p?.payoutId === 'string' &&
            uuid.test(p.payoutId) &&
            typeof p.makerId === 'string' &&
            uuid.test(p.makerId) &&
            typeof p.deltaPaise === 'string' &&
            /^-?[1-9][0-9]{0,17}$/.test(p.deltaPaise) &&
            typeof p.reason === 'string' &&
            p.reason.trim().length > 0 &&
            p.reason.length <= 300 &&
            typeof p.reference === 'string' &&
            p.reference.length > 0 &&
            p.reference.length <= 150
          );
        },
        execute: async (tx, payload, _key, checker) => {
          const p = payload as {
            payoutId: string;
            makerId: string;
            deltaPaise: string;
            reason: string;
            reference: string;
          };
          const rider = await riderFor(tx, p.payoutId);
          await lockActiveAccount(rider, tx);
          await lockRider(tx, rider);
          const payout = await lockPayout(tx, p.payoutId);
          if (!['APPROVED', 'PAID', 'SETTLED_ZERO'].includes(payout.state))
            throw new Error('PAYOUT_STATE_INVALID');
          const id = uuidV7();
          await sql`INSERT INTO payout_corrections(id,payout_id,reference,delta_paise,reason,state,maker_id,checker_id) VALUES(${id}::uuid,${p.payoutId}::uuid,${p.reference},${p.deltaPaise}::bigint,${p.reason},${BigInt(p.deltaPaise) > 0n ? 'CREDIT_PENDING' : 'RECEIVABLE_OPEN'},${p.makerId}::uuid,${checker}::uuid)`.execute(
            tx,
          );
          await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${checker}::uuid,'payout.correction_approved','payout_correction',${id},${JSON.stringify({ payoutId: p.payoutId, deltaPaise: p.deltaPaise })}::jsonb)`.execute(
            tx,
          );
        },
      },
    });
  }
  async list(
    actorId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      await authorize(tx, actorId);
      const result = await sql<{
        id: string;
      }>`SELECT id,rider_id,state,gross_paise::text,cash_offset_paise::text,net_paise::text,created_at,approved_at,paid_at FROM rider_payouts WHERE (${cursor ?? null}::uuid IS NULL OR id<${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
        tx,
      );
      const items = result.rows.slice(0, limit);
      return { items, nextCursor: result.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    });
  }
  async draft(riderId: string, cutoff: string): Promise<string | null> {
    const date = new Date(cutoff);
    if (
      !Number.isFinite(date.getTime()) ||
      date.getUTCDay() !== 0 ||
      date.getUTCHours() !== 18 ||
      date.getUTCMinutes() !== 30 ||
      date.getUTCSeconds() !== 0 ||
      date.getUTCMilliseconds() !== 0
    )
      throw new Error('INVALID_CUTOFF');
    return transactionWithRetry(this.db, async (tx) => {
      await lockActiveAccount(riderId, tx);
      await lockRider(tx, riderId);
      if (date > (await databaseTimeAfterLock(tx))) throw new Error('INVALID_CUTOFF');
      const draft = await sql<{
        id: string;
      }>`SELECT id FROM rider_payouts WHERE rider_id=${riderId}::uuid AND state='DRAFT'`.execute(
        tx,
      );
      if (draft.rows[0]) return draft.rows[0].id;
      const existing = await sql<{
        id: string;
      }>`SELECT p.id FROM rider_payouts p JOIN payout_batches b ON b.id=p.batch_id WHERE p.rider_id=${riderId}::uuid AND b.cutoff=${cutoff}::timestamptz AND p.state <> 'CANCELLED'`.execute(
        tx,
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const claims = await sql<{
        id: string;
        total_paise: string;
      }>`SELECT e.id,e.total_paise::text FROM rider_earnings e WHERE e.rider_id=${riderId}::uuid AND e.computed_at<${cutoff}::timestamptz AND e.payout_reference IS NULL AND NOT EXISTS(SELECT 1 FROM payout_earning_claims c WHERE c.earning_id=e.id AND c.active) ORDER BY e.computed_at,e.id FOR UPDATE`.execute(
        tx,
      );
      if (!claims.rows.length) return null;
      const gross = claims.rows.reduce((sum, row) => sum + BigInt(row.total_paise), 0n),
        held = await due(tx, riderId),
        offset = gross < held ? gross : held;
      const batch = await sql<{
        id: string;
      }>`INSERT INTO payout_batches(id,cutoff) VALUES(${uuidV7()}::uuid,${cutoff}::timestamptz) ON CONFLICT(cutoff) DO UPDATE SET cutoff=EXCLUDED.cutoff RETURNING id`.execute(
        tx,
      );
      const id = uuidV7();
      await sql`INSERT INTO rider_payouts(id,batch_id,rider_id,state,gross_paise,cash_offset_paise,net_paise) VALUES(${id}::uuid,${batch.rows[0]!.id}::uuid,${riderId}::uuid,'DRAFT',${gross.toString()}::bigint,${offset.toString()}::bigint,${(gross - offset).toString()}::bigint)`.execute(
        tx,
      );
      for (const row of claims.rows)
        await sql`INSERT INTO payout_earning_claims(payout_id,earning_id) VALUES(${id}::uuid,${row.id}::uuid)`.execute(
          tx,
        );
      return id;
    });
  }
  async cancel(actorId: string, id: string): Promise<void> {
    await transactionWithRetry(this.db, async (tx) => {
      await authorize(tx, actorId);
      const rider = await riderFor(tx, id);
      await lockRider(tx, rider);
      const p = await lockPayout(tx, id);
      if (p.state !== 'DRAFT') throw new Error('PAYOUT_STATE_INVALID');
      await sql`UPDATE payout_earning_claims SET active=false WHERE payout_id=${id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE rider_payouts SET state='CANCELLED',version=version+1 WHERE id=${id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${actorId}::uuid,'payout.cancelled','rider_payout',${id})`.execute(
        tx,
      );
    });
  }
  async requestApproval(actorId: string, id: string): Promise<string> {
    await transactionWithRetry(this.db, async (tx) => authorize(tx, actorId));
    const row = await sql<{
      version: string;
    }>`SELECT version::text FROM rider_payouts WHERE id=${id}::uuid AND state='DRAFT'`.execute(
      this.db,
    );
    if (!row.rows[0]) throw new Error('PAYOUT_STATE_INVALID');
    const version = row.rows[0].version;
    await sql`UPDATE maker_checker_requests SET status='EXPIRED' WHERE action='payout' AND maker_id=${actorId}::uuid AND payload->>'id'=${id} AND payload->>'version'=${version} AND status='PENDING' AND expires_at<=clock_timestamp()`.execute(
      this.db,
    );
    const existing = async () =>
      (
        await sql<{
          id: string;
        }>`SELECT id FROM maker_checker_requests WHERE action='payout' AND maker_id=${actorId}::uuid AND payload->>'id'=${id} AND payload->>'version'=${version} AND status='PENDING'`.execute(
          this.db,
        )
      ).rows[0]?.id;
    const prior = await existing();
    if (prior) return prior;
    try {
      return await this.approval.request(actorId, 'payout', { id, version });
    } catch (error) {
      const raced = await existing();
      if (raced) return raced;
      throw error;
    }
  }
  async approve(actorId: string, id: string): Promise<void> {
    await this.approval.approve(actorId, id);
  }
  async markPaid(input: {
    actorId: string;
    payoutId: string;
    paymentReference: string;
    evidenceMediaId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (
      !input.paymentReference.trim() ||
      input.paymentReference.length > 150 ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 150
    )
      throw new Error('INVALID_INPUT');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await transactionWithRetry(this.db, async (tx) => {
      await authorize(tx, input.actorId);
      const rider = await riderFor(tx, input.payoutId);
      await lockRider(tx, rider);
      const p = await lockPayout(tx, input.payoutId);
      if (p.state === 'PAID') {
        if (p.payment_request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return;
      }
      if (p.state !== 'APPROVED' || p.net_paise === '0') throw new Error('PAYOUT_STATE_INVALID');
      const media =
        await sql`SELECT id FROM private_media WHERE id=${input.evidenceMediaId}::uuid AND owner_id=${input.actorId}::uuid AND purpose='PAYOUT_EVIDENCE' AND state='STORED' FOR SHARE`.execute(
          tx,
        );
      if (!media.rows.length) throw new Error('MEDIA_NOT_FOUND');
      await sql`UPDATE rider_payouts SET state='PAID',payment_reference=${input.paymentReference},evidence_media_id=${input.evidenceMediaId}::uuid,payment_idempotency_key=${input.idempotencyKey},payment_request_hash=${hash},paid_at=clock_timestamp(),version=version+1 WHERE id=${input.payoutId}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${input.actorId}::uuid,'payout.mark_paid','rider_payout',${input.payoutId})`.execute(
        tx,
      );
    });
  }
  async listCorrections(
    actorId: string,
    payoutId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      await authorize(tx, actorId);
      const result = await sql<{
        id: string;
      }>`SELECT id,payout_id,delta_paise::text,reason,state,created_at,settled_at,payment_reference FROM payout_corrections WHERE payout_id=${payoutId}::uuid AND (${cursor ?? null}::uuid IS NULL OR id>${cursor ?? null}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
        tx,
      );
      const items = result.rows.slice(0, limit);
      return { items, nextCursor: result.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    });
  }
  async requestCorrection(input: {
    actorId: string;
    payoutId: string;
    deltaPaise: string;
    reason: string;
    reference: string;
  }): Promise<string> {
    if (
      !uuid.test(input.payoutId) ||
      !/^-?[1-9][0-9]{0,17}$/.test(input.deltaPaise) ||
      !input.reason.trim() ||
      input.reason.length > 300 ||
      !input.reference.trim() ||
      input.reference.length > 150
    )
      throw new Error('INVALID_INPUT');
    await transactionWithRetry(this.db, async (tx) => authorize(tx, input.actorId));
    const p = {
      payoutId: input.payoutId,
      deltaPaise: input.deltaPaise,
      reason: input.reason,
      reference: `${input.actorId}:${input.reference}`,
      makerId: input.actorId,
    };
    // The prefix may extend the client reference; keep it within the validated length.
    if (p.reference.length > 150) throw new Error('INVALID_INPUT');
    const existing = async () => {
      const row = await sql<{
        id: string;
        same: boolean;
      }>`SELECT id,payload=${JSON.stringify(p)}::jsonb AS same FROM maker_checker_requests WHERE action='payoutCorrection' AND maker_id=${input.actorId}::uuid AND payload->>'reference'=${p.reference}`.execute(
        this.db,
      );
      if (row.rows[0] && !row.rows[0].same) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return row.rows[0]?.id;
    };
    const prior = await existing();
    if (prior) return prior;
    try {
      return await this.approval.request(input.actorId, 'payoutCorrection', p);
    } catch (error) {
      const raced = await existing();
      if (raced) return raced;
      throw error;
    }
  }
  async settleCorrection(input: {
    actorId: string;
    correctionId: string;
    paymentReference: string;
    evidenceMediaId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (
      !input.paymentReference.trim() ||
      input.paymentReference.length > 150 ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 150
    )
      throw new Error('INVALID_INPUT');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await transactionWithRetry(this.db, async (tx) => {
      await authorize(tx, input.actorId);
      const row = await sql<{
        state: string;
        request_hash: string | null;
      }>`SELECT state,request_hash FROM payout_corrections WHERE id=${input.correctionId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (row.rows[0].state === 'SETTLED') {
        if (row.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return;
      }
      const media =
        await sql`SELECT id FROM private_media WHERE id=${input.evidenceMediaId}::uuid AND owner_id=${input.actorId}::uuid AND purpose='PAYOUT_EVIDENCE' AND state='STORED' FOR SHARE`.execute(
          tx,
        );
      if (!media.rows.length) throw new Error('MEDIA_NOT_FOUND');
      await sql`UPDATE payout_corrections SET state='SETTLED',payment_reference=${input.paymentReference},evidence_media_id=${input.evidenceMediaId}::uuid,idempotency_key=${input.idempotencyKey},request_hash=${hash},settled_at=clock_timestamp() WHERE id=${input.correctionId}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${input.actorId}::uuid,'payout.correction_settled','payout_correction',${input.correctionId})`.execute(
        tx,
      );
    });
  }
  async hasUnsettledPayout(riderId: string, tx?: TransactionContext): Promise<boolean> {
    const row = await sql<{
      present: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM rider_payouts WHERE rider_id=${riderId}::uuid AND state IN ('DRAFT','APPROVED')) OR EXISTS(SELECT 1 FROM payout_corrections c JOIN rider_payouts p ON p.id=c.payout_id WHERE p.rider_id=${riderId}::uuid AND c.state IN ('CREDIT_PENDING','RECEIVABLE_OPEN')) AS present`.execute(
      tx ?? this.db,
    );
    return row.rows[0]?.present ?? false;
  }
}
