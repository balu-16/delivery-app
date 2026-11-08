import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type {
  NotificationClass,
  NotificationStatus,
  NotificationView,
  NotificationViews,
  NotificationPage,
  NotificationCategory,
  NotificationChannel,
} from '../contracts/notifications.js';
import { loadTemplates } from './settings.js';
import { renderTemplate, selectTemplate } from '../domain/render.js';
import { decodeCursorExact, encodeCursor } from '../domain/cursor.js';

const UUID = /^[0-9a-f-]{36}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface Row {
  id: string;
  channel: NotificationChannel;
  template_key: string;
  locale: 'en' | 'hi' | 'te';
  category: NotificationCategory;
  class: NotificationClass;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  read_at: Date | null;
  created_at: Date;
  cursor_created_at: string;
  sent_at: Date | null;
}

/** Inbox reads; ownership is filtered inside every SQL statement (IDOR-safe). */
export class PostgresNotificationViews implements NotificationViews {
  constructor(private readonly db: Database) {}

  async inbox(userId: string, cursor?: string, limit?: number): Promise<NotificationPage> {
    if (!UUID.test(userId)) throw new Error('INVALID_INPUT');
    const size = limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_LIMIT)
      throw new Error('INVALID_INPUT');
    const decoded = cursor ? decodeCursorExact(cursor) : null;
    const rows = decoded
      ? await sql<Row>`SELECT id,channel,template_key,locale,category,class,payload,status,read_at,created_at,created_at::text AS cursor_created_at,sent_at FROM notifications WHERE user_id=${userId}::uuid AND channel='INBOX' AND status='SENT' AND (created_at, id) < (${decoded.timestamp}::timestamptz, ${decoded.id}::uuid) ORDER BY created_at DESC, id DESC LIMIT ${size + 1}`.execute(
          this.db,
        )
      : await sql<Row>`SELECT id,channel,template_key,locale,category,class,payload,status,read_at,created_at,created_at::text AS cursor_created_at,sent_at FROM notifications WHERE user_id=${userId}::uuid AND channel='INBOX' AND status='SENT' ORDER BY created_at DESC, id DESC LIMIT ${size + 1}`.execute(
          this.db,
        );
    const page = rows.rows.slice(0, size);
    const last = page.at(-1);
    const templates = await loadTemplates(this.db, [
      ...new Set(page.map((row) => row.template_key)),
    ]);
    return {
      items: page.map((row) => {
        const template = selectTemplate(templates, row.template_key, 'INBOX', row.locale);
        const data = (row.payload['data'] ?? {}) as Record<string, string>;
        return {
          ...viewOf(row),
          title: template ? renderTemplate(template.subject, data) : '',
          body: template ? renderTemplate(template.body, data) : '',
        };
      }),
      nextCursor:
        rows.rows.length > size && last ? encodeCursor(last.cursor_created_at, last.id) : null,
    };
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    if (!UUID.test(userId) || !UUID.test(notificationId)) throw new Error('INVALID_INPUT');
    const updated =
      await sql`UPDATE notifications SET read_at=clock_timestamp() WHERE id=${notificationId}::uuid AND user_id=${userId}::uuid AND channel='INBOX' AND status='SENT' AND read_at IS NULL`.execute(
        this.db,
      );
    if (Number(updated.numAffectedRows ?? 0) === 0) {
      const owned = await sql<{
        id: string;
      }>`SELECT id FROM notifications WHERE id=${notificationId}::uuid AND user_id=${userId}::uuid AND channel='INBOX' AND status='SENT'`.execute(
        this.db,
      );
      if (!owned.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    }
  }

  async markAllRead(userId: string): Promise<number> {
    if (!UUID.test(userId)) throw new Error('INVALID_INPUT');
    const updated = await sql<{
      id: string;
    }>`UPDATE notifications SET read_at=clock_timestamp() WHERE user_id=${userId}::uuid AND channel='INBOX' AND status='SENT' AND read_at IS NULL RETURNING id`.execute(
      this.db,
    );
    return updated.rows.length;
  }

  async unreadCount(userId: string): Promise<number> {
    if (!UUID.test(userId)) throw new Error('INVALID_INPUT');
    const rows = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM notifications WHERE user_id=${userId}::uuid AND channel='INBOX' AND status='SENT' AND read_at IS NULL`.execute(
      this.db,
    );
    return Number(rows.rows[0]?.count ?? '0');
  }
}

function viewOf(row: Row): Omit<NotificationView, 'title' | 'body'> {
  return {
    id: row.id,
    channel: row.channel,
    templateKey: row.template_key,
    category: row.category,
    class: row.class,
    payload: row.payload,
    status: row.status,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
  };
}
