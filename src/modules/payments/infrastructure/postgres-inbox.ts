import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { MAX_INBOX_ATTEMPTS, type InboxState, type QuarantineReason } from '../domain/states.js';

export interface InboxRow {
  id: string;
  gateway: string;
  gateway_event_id: string;
  event_type: string | null;
  body: string;
  body_hash: string;
  signature: string;
  signature_valid: boolean;
  state: InboxState;
  quarantine_reason: QuarantineReason | null;
  attempts: number;
  next_attempt_at: Date;
  processed_at: Date | null;
  created_at: Date;
}
const COLUMNS =
  'id,gateway,gateway_event_id,event_type,body,body_hash,signature,signature_valid,state,quarantine_reason,attempts,next_attempt_at,processed_at,created_at';

/**
 * Raw webhook inbox (plan 5.4.4). Events are persisted before any processing
 * with UNIQUE (gateway, gateway_event_id); duplicates are 200 no-ops; the same
 * event id with a different signed body is rejected before processing. The
 * attempt counter commits with the PROCESSING claim so a failed effect can
 * never retry unbounded (MAX_INBOX_ATTEMPTS), and the terminal state commits
 * in the same transaction as its business effect.
 */
export class PostgresWebhookInbox {
  constructor(private readonly db: Database) {}

  /** Inserts the raw event; a duplicate with an identical body is a no-op. */
  async insert(input: {
    gateway: string;
    eventId: string;
    eventType: string | null;
    body: string;
    signature: string;
    signatureValid: boolean;
  }): Promise<{ inboxId: string; duplicate: boolean; bodyHash: string }> {
    if (!/^(fake|razorpay)$/.test(input.gateway)) throw new Error('INVALID_INPUT');
    if (!input.eventId || input.eventId.length > 512 || input.body.length > 1_000_000)
      throw new Error('INVALID_INPUT');
    const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex');
    return this.db.transaction().execute(async (tx) => {
      const inserted = await sql<{ id: string }>`INSERT INTO gateway_event_inbox
        (id,gateway,gateway_event_id,event_type,body,body_hash,signature,signature_valid,state,quarantine_reason)
        VALUES (${uuidV7()}::uuid,${input.gateway},${input.eventId},${input.eventType},${input.body},${bodyHash},${input.signature},${input.signatureValid},${input.signatureValid ? 'PENDING' : 'QUARANTINED'},${input.signatureValid ? null : 'SIGNATURE_INVALID'})
        ON CONFLICT (gateway,gateway_event_id) DO NOTHING RETURNING id`.execute(tx);
      if (inserted.rows[0]) return { inboxId: inserted.rows[0].id, duplicate: false, bodyHash };
      const existing = await sql<{
        id: string;
        body_hash: string;
      }>`SELECT id,body_hash FROM gateway_event_inbox
        WHERE gateway=${input.gateway} AND gateway_event_id=${input.eventId} FOR UPDATE`.execute(
        tx,
      );
      const row = existing.rows[0];
      if (!row) throw new Error('INBOX_INSERT_LOST');
      if (row.body_hash !== bodyHash) throw new Error('INBOX_BODY_CHANGED');
      return { inboxId: row.id, duplicate: true, bodyHash };
    });
  }

  async byId(id: string): Promise<InboxRow | null> {
    const result = await sql<InboxRow>`SELECT ${sql.raw(COLUMNS)}
      FROM gateway_event_inbox WHERE id=${id}::uuid`.execute(this.db);
    return result.rows[0] ?? null;
  }

  /**
   * Claims one due event: PROCESSING plus the attempt increment commit alone,
   * so a rolled-back effect still counts against the bounded attempts. Returns
   * the current row when no claim was possible (terminal or exhausted).
   */
  async claim(inboxId: string): Promise<InboxRow | null> {
    return this.db.transaction().execute(async (tx) => {
      const claimed =
        await sql<InboxRow>`UPDATE gateway_event_inbox SET state='PROCESSING',attempts=attempts+1, next_attempt_at=clock_timestamp() + interval '5 minutes'
        WHERE id=${inboxId}::uuid AND signature_valid AND state IN ('PENDING','PROCESSING') AND next_attempt_at <= clock_timestamp() AND attempts < ${MAX_INBOX_ATTEMPTS}
        RETURNING ${sql.raw(COLUMNS)}`.execute(tx);
      if (claimed.rows[0]) return claimed.rows[0];
      const current =
        await sql<InboxRow>`SELECT ${sql.raw(COLUMNS)} FROM gateway_event_inbox WHERE id=${inboxId}::uuid FOR UPDATE`.execute(
          tx,
        );
      return current.rows[0]?.state === 'PROCESSING' ? null : (current.rows[0] ?? null);
    });
  }

  /** Terminal success commits with the business effect (one transaction). */
  async completeTx(tx: TransactionContext, id: string): Promise<void> {
    await sql`UPDATE gateway_event_inbox SET state='PROCESSED',processed_at=clock_timestamp()
      WHERE id=${id}::uuid AND state='PROCESSING'`.execute(tx);
  }

  /** Terminal quarantine commits with the finding (one transaction). */
  async quarantineTx(tx: TransactionContext, id: string, reason: QuarantineReason): Promise<void> {
    await sql`UPDATE gateway_event_inbox SET state='QUARANTINED',quarantine_reason=${reason}
      WHERE id=${id}::uuid AND state IN ('PENDING','PROCESSING')`.execute(tx);
  }

  /** Bounded escalation keeps the event retryable with exponential backoff. */
  async scheduleRetry(id: string, attempt: number): Promise<void> {
    await sql`UPDATE gateway_event_inbox SET state='PENDING',
      next_attempt_at=clock_timestamp() + (LEAST(300, power(2, LEAST(attempts, 8))) * interval '1 second')
      WHERE id=${id}::uuid AND state='PROCESSING' AND attempts=${attempt}`.execute(this.db);
  }

  /** Recovery scan after Redis loss: due durable rows are re-enqueued. */
  async due(limit: number): Promise<readonly InboxRow[]> {
    const result = await sql<InboxRow>`SELECT ${sql.raw(COLUMNS)}
      FROM gateway_event_inbox WHERE signature_valid AND state IN ('PENDING','PROCESSING') AND next_attempt_at <= clock_timestamp() AND attempts < ${MAX_INBOX_ATTEMPTS}
      ORDER BY next_attempt_at,id LIMIT ${limit}`.execute(this.db);
    return result.rows;
  }
}
