import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import type { AgentCard, AgentLocale } from '../contracts/agent.js';

interface ThreadRow {
  id: string;
  user_id: string;
  status: 'active' | 'archived';
  locale: AgentLocale;
}
interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system_note';
  text: string;
  cards: AgentCard[];
  created_at: Date;
  cursor_created_at: string;
}
export interface AgentMessageView {
  id: string;
  role: MessageRow['role'];
  text: string;
  cards: AgentCard[];
  createdAt: string;
}
export interface AgentThreadView {
  id: string;
  messages: AgentMessageView[];
  nextCursor: string | null;
}
export interface AgentThreadSummary {
  id: string;
  title: string | null;
  status: 'active' | 'archived';
  lastMessageAt: string;
}

function messageView(row: MessageRow): AgentMessageView {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    cards: Array.isArray(row.cards) ? row.cards : [],
    createdAt: row.created_at.toISOString(),
  };
}
function cursorFor(row: MessageRow): string {
  // JavaScript Date drops PostgreSQL's microseconds; retain the exact cursor.
  return Buffer.from(JSON.stringify([row.cursor_created_at, row.id])).toString('base64url');
}
function readCursor(value: string): { at: string; id: string } {
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_CURSOR');
    const data: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(data) ||
      data.length !== 2 ||
      typeof data[0] !== 'string' ||
      typeof data[1] !== 'string' ||
      !Number.isFinite(Date.parse(data[0])) ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(data[1])
    )
      throw new Error('INVALID_CURSOR');
    return { at: data[0], id: data[1] };
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}

export class AgentThreads {
  constructor(private readonly db: Database) {}

  private async lockCustomer(userId: string, tx: TransactionContext): Promise<void> {
    const result =
      await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
        tx,
      );
    if (!result.rows.length) throw new Error('ACCOUNT_DISABLED');
  }

  async owned(userId: string, threadId: string, tx?: TransactionContext): Promise<ThreadRow> {
    const result =
      await sql<ThreadRow>`SELECT id,user_id,status,locale FROM agent_threads WHERE id=${threadId}::uuid AND user_id=${userId}::uuid`.execute(
        tx ?? this.db,
      );
    if (!result.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    return result.rows[0];
  }

  async list(
    userId: string,
    cursor?: string,
  ): Promise<{ items: AgentThreadSummary[]; nextCursor: string | null }> {
    const before = cursor ? readCursor(cursor) : null;
    const rows = await sql<{
      id: string;
      title: string | null;
      status: 'active' | 'archived';
      last_message_at: Date;
      cursor_at: string;
    }>`SELECT id,title,status,last_message_at,last_message_at::text AS cursor_at FROM agent_threads
      WHERE user_id=${userId}::uuid AND (${before?.at ?? null}::timestamptz IS NULL OR (last_message_at,id)<(${before?.at ?? null}::timestamptz,${before?.id ?? null}::uuid))
      ORDER BY last_message_at DESC,id DESC LIMIT 31`.execute(this.db);
    const page = rows.rows.slice(0, 30),
      last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        lastMessageAt: row.last_message_at.toISOString(),
      })),
      nextCursor:
        rows.rows.length > 30 && last
          ? Buffer.from(JSON.stringify([last.cursor_at, last.id])).toString('base64url')
          : null,
    };
  }

  async current(userId: string, locale: AgentLocale = 'en'): Promise<AgentThreadView> {
    const id = await this.db.transaction().execute(async (tx) => {
      await this.lockCustomer(userId, tx);
      const current = await sql<{
        id: string;
      }>`SELECT id FROM agent_threads WHERE user_id=${userId}::uuid AND status='active'`.execute(
        tx,
      );
      if (current.rows[0]) return current.rows[0].id;
      const newId = uuidV7();
      await sql`INSERT INTO agent_threads(id,user_id,locale) VALUES(${newId}::uuid,${userId}::uuid,${locale})`.execute(
        tx,
      );
      return newId;
    });
    return { id, ...(await this.messages(userId, id)) };
  }

  async create(userId: string, locale: AgentLocale = 'en'): Promise<AgentThreadView> {
    const id = await this.db.transaction().execute(async (tx) => {
      await this.lockCustomer(userId, tx);
      const queued =
        await sql`SELECT id FROM agent_jobs WHERE user_id=${userId}::uuid AND state IN ('queued','running') LIMIT 1`.execute(
          tx,
        );
      if (queued.rows.length) throw new Error('RUN_IN_PROGRESS');
      const running =
        await sql`SELECT id FROM agent_runs WHERE user_id=${userId}::uuid AND outcome='running' AND created_at>clock_timestamp()-interval '5 minutes' LIMIT 1`.execute(
          tx,
        );
      if (running.rows.length) throw new Error('RUN_IN_PROGRESS');
      await sql`UPDATE agent_drafts SET status='superseded',updated_at=clock_timestamp() WHERE user_id=${userId}::uuid AND status='pending'`.execute(
        tx,
      );
      await sql`UPDATE agent_cart_choices SET status='superseded',updated_at=clock_timestamp() WHERE user_id=${userId}::uuid AND status='pending'`.execute(
        tx,
      );
      await sql`UPDATE agent_threads SET status='archived' WHERE user_id=${userId}::uuid AND status='active'`.execute(
        tx,
      );
      const next = uuidV7();
      await sql`INSERT INTO agent_threads(id,user_id,locale) VALUES(${next}::uuid,${userId}::uuid,${locale})`.execute(
        tx,
      );
      return next;
    });
    return { id, messages: [], nextCursor: null };
  }

  async title(userId: string, threadId: string): Promise<string | null> {
    const found = await sql<{ title: string | null }>`SELECT title FROM agent_threads
      WHERE id=${threadId}::uuid AND user_id=${userId}::uuid`.execute(this.db);
    return found.rows[0]?.title ?? null;
  }

  async messages(
    userId: string,
    threadId: string,
    cursor?: string,
  ): Promise<{ messages: AgentMessageView[]; nextCursor: string | null }> {
    await this.owned(userId, threadId);
    const before = cursor ? readCursor(cursor) : null;
    const rows =
      await sql<MessageRow>`SELECT id,role,text,cards,created_at,created_at::text AS cursor_created_at FROM agent_messages
      WHERE thread_id=${threadId}::uuid AND (${before?.at ?? null}::timestamptz IS NULL OR (created_at,id)<(${before?.at ?? null}::timestamptz,${before?.id ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`.execute(this.db);
    const page = rows.rows.slice(0, 50);
    const ids = page.flatMap((row) =>
      Array.isArray(row.cards)
        ? row.cards
            .map((card) => card.payload?.draftId)
            .filter(
              (id): id is string =>
                typeof id === 'string' &&
                /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id),
            )
        : [],
    );
    const statuses = ids.length
      ? await sql<{
          id: string;
          status: string;
          expired: boolean;
        }>`SELECT id::text,status,expires_at<=clock_timestamp() AS expired FROM agent_drafts WHERE user_id=${userId}::uuid AND thread_id=${threadId}::uuid AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`))})`.execute(
          this.db,
        )
      : { rows: [] };
    const drafts = new Map(
      statuses.rows.map((row) => [
        row.id,
        row.status === 'pending' && row.expired ? 'expired' : row.status,
      ]),
    );
    const choiceIds = page.flatMap((row) =>
      (Array.isArray(row.cards) ? row.cards : [])
        .filter((card) => card.type === 'cart_choice')
        .map((card) => card.payload?.choiceId)
        .filter(
          (id): id is string =>
            typeof id === 'string' &&
            /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id),
        ),
    );
    const choices = new Map(
      choiceIds.length
        ? (
            await sql<{
              id: string;
              version: number;
              status: string;
              expired: boolean;
              selection: unknown;
            }>`SELECT id::text,version,status,expires_at<=clock_timestamp() AS expired,selection FROM agent_cart_choices
      WHERE user_id=${userId}::uuid AND thread_id=${threadId}::uuid AND id IN (${sql.join(choiceIds.map((id) => sql`${id}::uuid`))})`.execute(
              this.db,
            )
          ).rows.map((row) => [row.id, row])
        : [],
    );
    const messages = page.reverse().map((row) => {
      const message = messageView(row);
      message.cards = message.cards.map((card) => {
        const choiceId = card.payload?.choiceId;
        if (card.type === 'cart_choice' && typeof choiceId === 'string') {
          const choice = choices.get(choiceId);
          const version = card.payload.choiceVersion;
          const status =
            !choice ||
            (version === undefined
              ? Boolean(choice.selection) && choice.status === 'pending'
              : choice.version !== version)
              ? 'superseded'
              : choice.status === 'pending' && choice.expired
                ? 'expired'
                : choice.status;
          return { ...card, payload: { ...card.payload, status } };
        }
        const draftId = card.payload?.draftId;
        return typeof draftId === 'string'
          ? { ...card, payload: { ...card.payload, status: drafts.get(draftId) ?? 'superseded' } }
          : card;
      });
      return message;
    });
    return { messages, nextCursor: rows.rows.length > 50 ? cursorFor(rows.rows[49]!) : null };
  }

  async append(
    userId: string,
    threadId: string,
    role: MessageRow['role'],
    text: string,
    cards: AgentCard[] = [],
    clientMessageId?: string,
    outer?: TransactionContext,
  ): Promise<string> {
    const id = uuidV7();
    const append = async (tx: TransactionContext) => {
      const thread = await this.owned(userId, threadId, tx);
      if (thread.status !== 'active') throw new Error('THREAD_ARCHIVED');
      const inserted = await sql<{
        id: string;
      }>`INSERT INTO agent_messages(id,thread_id,role,text,cards,client_message_id)
        VALUES(${id}::uuid,${threadId}::uuid,${role},${text},${JSON.stringify(cards as unknown as Json)}::jsonb,${clientMessageId ?? null}::uuid)
        ON CONFLICT(thread_id,client_message_id) DO NOTHING RETURNING id`.execute(tx);
      if (!inserted.rows[0] && clientMessageId) {
        const existing = await sql<{
          id: string;
          text: string;
          role: string;
        }>`SELECT id,text,role FROM agent_messages WHERE thread_id=${threadId}::uuid AND client_message_id=${clientMessageId}::uuid`.execute(
          tx,
        );
        if (!existing.rows[0] || existing.rows[0].text !== text || existing.rows[0].role !== role)
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        return existing.rows[0].id;
      }
      await sql`UPDATE agent_threads SET last_message_at=clock_timestamp() WHERE id=${threadId}::uuid`.execute(
        tx,
      );
      return id;
    };
    return outer ? append(outer) : this.db.transaction().execute(append);
  }

  async feedback(
    userId: string,
    messageId: string,
    rating: 'up' | 'down',
    reason?: string,
  ): Promise<void> {
    const result = await sql`INSERT INTO agent_feedback(message_id,user_id,rating,reason)
      SELECT m.id,t.user_id,${rating},${reason ?? null} FROM agent_messages m JOIN agent_threads t ON t.id=m.thread_id
      WHERE m.id=${messageId}::uuid AND t.user_id=${userId}::uuid AND m.role='assistant'
      ON CONFLICT(message_id) DO UPDATE SET rating=EXCLUDED.rating,reason=EXCLUDED.reason,created_at=clock_timestamp()
      WHERE agent_feedback.user_id=EXCLUDED.user_id RETURNING message_id`.execute(this.db);
    if (!result.rows.length) throw new Error('RESOURCE_NOT_FOUND');
  }
  async systemNotes(userId: string, threadId: string): Promise<{ id: string; text: string }[]> {
    const rows = await sql<{
      id: string;
      text: string;
    }>`SELECT m.id::text,m.text FROM agent_messages m JOIN agent_threads t ON t.id=m.thread_id
      WHERE t.user_id=${userId}::uuid AND t.id=${threadId}::uuid AND m.role='system_note' ORDER BY m.created_at DESC,m.id DESC LIMIT 20`.execute(
      this.db,
    );
    return rows.rows.reverse();
  }
}
