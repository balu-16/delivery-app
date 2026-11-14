import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { hashRequest } from '../../../common/idempotency/idempotency.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { lockActiveAccount } from '../../identity/contracts/account-lock.js';
import type { PrivateUploadPort } from '../../identity/contracts/uploads.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { Support, TicketStatus } from '../contracts/support.js';
function clean(value: string, max: number): string {
  const t = value.trim();
  if (!t || t.length > max) throw new Error('INVALID_INPUT');
  return t
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
async function staff(tx: TransactionContext, actorId: string): Promise<boolean> {
  const actor = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
    WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE'
      AND r.role IN ('SUPPORT_AGENT','SUPER_ADMIN') FOR SHARE OF u,r`.execute(tx);
  return actor.rows.length > 0;
}
export class PostgresSupport implements Support {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly uploads: PrivateUploadPort,
  ) {}
  private async operation(
    tx: TransactionContext,
    actor: string,
    operation: string,
    reference: string | undefined,
    input: unknown,
  ): Promise<string | null> {
    if (!reference) return null;
    if (reference.length > 150) throw new Error('INVALID_INPUT');
    const row = await sql<{
      request_hash: string;
      result_id: string;
    }>`SELECT request_hash,result_id FROM support_operations WHERE actor_id=${actor}::uuid AND operation=${operation} AND reference=${reference}`.execute(
      tx,
    );
    if (!row.rows[0]) return null;
    if (row.rows[0].request_hash !== hashRequest(JSON.stringify(input)))
      throw new Error('IDEMPOTENCY_KEY_REUSED');
    return row.rows[0].result_id;
  }
  private async saveOperation(
    tx: TransactionContext,
    actor: string,
    operation: string,
    reference: string | undefined,
    input: unknown,
    result: string,
  ): Promise<void> {
    if (reference)
      await sql`INSERT INTO support_operations(actor_id,operation,reference,request_hash,result_id) VALUES(${actor}::uuid,${operation},${reference},${hashRequest(JSON.stringify(input))},${result}::uuid)`.execute(
        tx,
      );
  }
  async uploadTarget(actorId: string, type: string, size: number) {
    return this.uploads.createTarget(actorId, 'SUPPORT_ATTACHMENT', type, size);
  }
  private async verifyMedia(actorId: string, ids: readonly string[]): Promise<void> {
    if (ids.length > 5 || new Set(ids).size !== ids.length) throw new Error('INVALID_INPUT');
    for (const id of ids)
      await this.uploads.assertOwnedRegistered(actorId, id, 'SUPPORT_ATTACHMENT');
  }
  async create(
    actorId: string,
    input: {
      category: string;
      orderId?: string;
      body: string;
      mediaIds?: string[];
      reference?: string;
    },
  ): Promise<string> {
    const max = await this.config.get('supportMessageMaxLength'),
      body = clean(input.body, max),
      category = clean(input.category, 80),
      ids = input.mediaIds ?? [];
    await this.verifyMedia(actorId, ids);
    return transactionWithRetry(this.db, async (tx) => {
      await lockActiveAccount(actorId, tx);
      const replay = await this.operation(tx, actorId, 'ticket.create', input.reference, input);
      if (replay) return replay;
      const allowed =
        await sql`SELECT 1 FROM user_roles WHERE user_id=${actorId}::uuid AND role IN ('CUSTOMER','RIDER')`.execute(
          tx,
        );
      if (!allowed.rows.length) throw new Error('FORBIDDEN');
      const limit = await this.config.get('supportTicketCreationLimitPerHour', tx),
        count = await sql<{
          n: string;
        }>`SELECT COUNT(*)::text AS n FROM support_tickets WHERE owner_id=${actorId}::uuid AND incident_key IS NULL AND created_at>clock_timestamp()-interval '1 hour'`.execute(
          tx,
        );
      if (Number(count.rows[0]?.n ?? 0) >= limit) throw new Error('RATE_LIMITED');
      if (input.orderId) {
        const order =
          await sql`SELECT id FROM orders WHERE id=${input.orderId}::uuid AND (user_id=${actorId}::uuid OR EXISTS(SELECT 1 FROM delivery_tasks d WHERE d.order_id=orders.id AND d.rider_id=${actorId}::uuid) OR EXISTS(SELECT 1 FROM rider_earnings e WHERE e.order_id=orders.id AND e.rider_id=${actorId}::uuid))`.execute(
            tx,
          );
        if (!order.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      }
      const first = await this.config.get('supportFirstResponseSlaHours', tx),
        resolution = await this.config.get('supportResolutionSlaHours', tx),
        id = uuidV7(),
        message = uuidV7();
      await sql`INSERT INTO support_tickets(id,owner_id,order_id,category,status,first_response_due_at,resolution_due_at) VALUES(${id}::uuid,${actorId}::uuid,${input.orderId ?? null}::uuid,${category},'OPEN',clock_timestamp()+${first}*interval '1 hour',clock_timestamp()+${resolution}*interval '1 hour')`.execute(
        tx,
      );
      await sql`INSERT INTO support_ticket_messages(id,ticket_id,author_id,body) VALUES(${message}::uuid,${id}::uuid,${actorId}::uuid,${body})`.execute(
        tx,
      );
      for (const media of ids)
        await sql`INSERT INTO support_ticket_attachments(ticket_id,message_id,media_id) VALUES(${id}::uuid,${message}::uuid,${media}::uuid)`.execute(
          tx,
        );
      await this.saveOperation(tx, actorId, 'ticket.create', input.reference, input, id);
      return id;
    });
  }
  async list(actorId: string, isStaff: boolean, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      if (isStaff && !(await staff(tx, actorId))) throw new Error('FORBIDDEN');
      const rows = await sql<{
        id: string;
      }>`SELECT id,order_id,category,status,assignee_id,created_at FROM support_tickets WHERE (${isStaff} OR owner_id=${actorId}::uuid) AND (${cursor ?? null}::uuid IS NULL OR id<${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
        tx,
      );
      const page = rows.rows.slice(0, limit);
      return {
        items: page,
        nextCursor: rows.rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }
  async detail(
    actorId: string,
    id: string,
    isStaff: boolean,
    cursor?: string,
    limit = 50,
  ): Promise<unknown> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      if (isStaff && !(await staff(tx, actorId))) throw new Error('FORBIDDEN');
      const rows =
        await sql`SELECT id,owner_id,order_id,category,status,assignee_id,created_at,updated_at FROM support_tickets WHERE id=${id}::uuid AND (${isStaff} OR owner_id=${actorId}::uuid)`.execute(
          tx,
        );
      if (!rows.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      const result = await sql<{
        id: string;
      }>`SELECT m.id,m.author_id,m.body,m.internal,m.created_at,COALESCE((SELECT jsonb_agg(a.media_id) FROM support_ticket_attachments a WHERE a.message_id=m.id),'[]'::jsonb) AS attachments FROM support_ticket_messages m WHERE m.ticket_id=${id}::uuid AND (${isStaff} OR NOT m.internal) AND (${cursor ?? null}::uuid IS NULL OR m.id>${cursor ?? null}::uuid) ORDER BY m.id LIMIT ${limit + 1}`.execute(
        tx,
      );
      const messages = result.rows.slice(0, limit);
      return {
        ticket: rows.rows[0],
        messages,
        nextMessagesCursor: result.rows.length > limit ? (messages.at(-1)?.id ?? null) : null,
      };
    });
  }
  async canned(
    actorId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      if (!(await staff(tx, actorId))) throw new Error('FORBIDDEN');
      const result = await sql<{
        id: string;
      }>`SELECT id,label,body FROM support_canned_responses WHERE active AND (${cursor ?? null}::uuid IS NULL OR id>${cursor ?? null}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
        tx,
      );
      const items = result.rows.slice(0, limit);
      return { items, nextCursor: result.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    });
  }
  async saveCanned(
    actorId: string,
    input: { id?: string; label: string; body: string; active: boolean },
  ): Promise<string> {
    const label = clean(input.label, 80),
      body = clean(input.body, await this.config.get('supportMessageMaxLength'));
    return transactionWithRetry(this.db, async (tx) => {
      const authorized =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') FOR SHARE OF u,r`.execute(
          tx,
        );
      if (!authorized.rows.length) throw new Error('FORBIDDEN');
      const id = input.id ?? uuidV7();
      await sql`INSERT INTO support_canned_responses(id,label,body,active,updated_by) VALUES(${id}::uuid,${label},${body},${input.active},${actorId}::uuid) ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,body=EXCLUDED.body,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${actorId}::uuid,'support.canned_updated','canned_response',${id})`.execute(
        tx,
      );
      return id;
    });
  }
  async orderForStaff(actorId: string, ticketId: string): Promise<string> {
    return transactionWithRetry(this.db, async (tx) => {
      if (!(await staff(tx, actorId))) throw new Error('FORBIDDEN');
      const result = await sql<{
        order_id: string | null;
      }>`SELECT order_id FROM support_tickets WHERE id=${ticketId}::uuid`.execute(tx);
      if (!result.rows[0]?.order_id) throw new Error('RESOURCE_NOT_FOUND');
      return result.rows[0].order_id;
    });
  }
  private async lockTicketAccounts(
    tx: TransactionContext,
    actorId: string,
    ticketId: string,
  ): Promise<void> {
    const ticket = await sql<{
      owner_id: string;
    }>`SELECT owner_id FROM support_tickets WHERE id=${ticketId}::uuid`.execute(tx);
    if (!ticket.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    for (const user of [...new Set([actorId, ticket.rows[0].owner_id])].sort())
      await lockActiveAccount(user, tx);
  }
  async message(
    actorId: string,
    id: string,
    input: { body: string; internal?: boolean; mediaIds?: string[]; reference?: string },
  ): Promise<string> {
    const body = clean(input.body, await this.config.get('supportMessageMaxLength')),
      ids = input.mediaIds ?? [];
    await this.verifyMedia(actorId, ids);
    return transactionWithRetry(this.db, async (tx) => {
      await this.lockTicketAccounts(tx, actorId, id);
      const replay = await this.operation(
        tx,
        actorId,
        `ticket.message:${id}`,
        input.reference,
        input,
      );
      if (replay) return replay;
      const ticket = await sql<{
        owner_id: string;
        status: string;
      }>`SELECT owner_id,status FROM support_tickets WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
      if (!ticket.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      const privileged = await staff(tx, actorId);
      if (!privileged && ticket.rows[0].owner_id !== actorId) throw new Error('RESOURCE_NOT_FOUND');
      if (input.internal && !privileged) throw new Error('FORBIDDEN');
      if (ticket.rows[0].status === 'CLOSED') throw new Error('TICKET_CLOSED');
      const message = uuidV7();
      await sql`INSERT INTO support_ticket_messages(id,ticket_id,author_id,body,internal) VALUES(${message}::uuid,${id}::uuid,${actorId}::uuid,${body},${input.internal ?? false})`.execute(
        tx,
      );
      for (const media of ids)
        await sql`INSERT INTO support_ticket_attachments(ticket_id,message_id,media_id) VALUES(${id}::uuid,${message}::uuid,${media}::uuid)`.execute(
          tx,
        );
      if (privileged && !input.internal)
        await sql`UPDATE support_tickets SET first_response_at=COALESCE(first_response_at,clock_timestamp()),updated_at=clock_timestamp(),version=version+1 WHERE id=${id}::uuid`.execute(
          tx,
        );
      await this.saveOperation(
        tx,
        actorId,
        `ticket.message:${id}`,
        input.reference,
        input,
        message,
      );
      return message;
    });
  }
  async update(
    actorId: string,
    id: string,
    input: { status?: TicketStatus; assigneeId?: string | null },
  ): Promise<void> {
    await transactionWithRetry(this.db, async (tx) => {
      await this.lockTicketAccounts(tx, actorId, id);
      const row = await sql<{
        owner_id: string;
        status: TicketStatus;
        closed_at: Date | null;
        resolved_at: Date | null;
      }>`SELECT owner_id,status,closed_at,resolved_at FROM support_tickets WHERE id=${id}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!row.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      const privileged = await staff(tx, actorId),
        ticket = row.rows[0],
        now = await databaseTimeAfterLock(tx);
      if (!privileged && ticket.owner_id !== actorId) throw new Error('RESOURCE_NOT_FOUND');
      if (input.assigneeId !== undefined && !privileged) throw new Error('FORBIDDEN');
      if (input.assigneeId) {
        const target = await staff(tx, input.assigneeId);
        if (!target) throw new Error('FORBIDDEN');
      }
      if (input.status === 'OPEN' && ticket.status === 'OPEN' && input.assigneeId === undefined)
        return;
      if (input.status) {
        const allowed: Record<TicketStatus, TicketStatus[]> = {
          OPEN: ['IN_PROGRESS', 'RESOLVED'],
          IN_PROGRESS: ['RESOLVED'],
          RESOLVED: ['CLOSED', 'OPEN'],
          CLOSED: ['OPEN'],
        };
        if (!allowed[ticket.status].includes(input.status)) throw new Error('TICKET_STATE_INVALID');
        if (!privileged && input.status !== 'OPEN') throw new Error('FORBIDDEN');
        if (input.status === 'OPEN') {
          const window = await this.config.get('supportReopenDays', tx);
          if (
            (ticket.status === 'CLOSED' &&
              (!ticket.closed_at ||
                now.getTime() - ticket.closed_at.getTime() > window * 86400000)) ||
            (ticket.status === 'RESOLVED' &&
              (!ticket.resolved_at ||
                now.getTime() - ticket.resolved_at.getTime() > window * 86400000))
          )
            throw new Error('REOPEN_WINDOW_EXPIRED');
        }
      }
      const firstSla =
        input.status === 'OPEN' ? await this.config.get('supportFirstResponseSlaHours', tx) : 0;
      const resolutionSla =
        input.status === 'OPEN' ? await this.config.get('supportResolutionSlaHours', tx) : 0;
      await sql`UPDATE support_tickets SET sla_cycle=CASE WHEN ${input.status ?? null}='OPEN' THEN sla_cycle+1 ELSE sla_cycle END,first_response_at=CASE WHEN ${input.status ?? null}='OPEN' THEN NULL ELSE first_response_at END,first_response_due_at=CASE WHEN ${input.status ?? null}='OPEN' THEN clock_timestamp()+${firstSla}*interval '1 hour' ELSE first_response_due_at END,resolution_due_at=CASE WHEN ${input.status ?? null}='OPEN' THEN clock_timestamp()+${resolutionSla}*interval '1 hour' ELSE resolution_due_at END,status=COALESCE(${input.status ?? null},status),assignee_id=CASE WHEN ${input.assigneeId !== undefined} THEN ${input.assigneeId ?? null}::uuid ELSE assignee_id END,resolved_at=CASE WHEN ${input.status ?? null}='RESOLVED' THEN clock_timestamp() ELSE resolved_at END,closed_at=CASE WHEN ${input.status ?? null}='CLOSED' THEN clock_timestamp() WHEN ${input.status ?? null}='OPEN' THEN NULL ELSE closed_at END,updated_at=clock_timestamp(),version=version+1 WHERE id=${id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actorId}::uuid,'support.ticket_updated','ticket',${id},${JSON.stringify(input)}::jsonb)`.execute(
        tx,
      );
    });
  }
  async attachmentUrl(actorId: string, ticketId: string, mediaId: string): Promise<string> {
    await transactionWithRetry(this.db, async (tx) => {
      const privileged = await staff(tx, actorId);
      const a =
        await sql`SELECT a.media_id FROM support_ticket_attachments a JOIN support_tickets t ON t.id=a.ticket_id LEFT JOIN support_ticket_messages m ON m.id=a.message_id WHERE a.ticket_id=${ticketId}::uuid AND a.media_id=${mediaId}::uuid AND (${privileged} OR (t.owner_id=${actorId}::uuid AND NOT COALESCE(m.internal,false)))`.execute(
          tx,
        );
      if (!a.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    });
    return this.uploads.signedRead(mediaId);
  }
}
