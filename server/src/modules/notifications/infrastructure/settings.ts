import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { QuietWindow } from '../domain/quiet-hours.js';
import type { TemplateRow } from '../domain/render.js';

/** Typed business settings; failures propagate to the delivery retry. */
export class QuietHoursSettings {
  constructor(private readonly config: AppConfig) {}
  async get(): Promise<QuietWindow> {
    const [startMinute, endMinute] = await Promise.all([
      this.config.get('notificationQuietHoursStart'),
      this.config.get('notificationQuietHoursEnd'),
    ]);
    return { startMinute, endMinute };
  }
}

/** Loads template rows for rendering (small table; read per send batch). */
export async function loadTemplates(
  client: Database | TransactionContext,
  keys: readonly string[],
): Promise<TemplateRow[]> {
  if (!keys.length) return [];
  const rows = await sql<{
    template_key: string;
    locale: string;
    channel: string;
    subject: string;
    body: string;
  }>`SELECT template_key,locale,channel,subject,body FROM notification_templates WHERE template_key = ANY(${keys}::text[])`.execute(
    client,
  );
  return rows.rows.map((row) => ({
    templateKey: row.template_key,
    locale: row.locale as TemplateRow['locale'],
    channel: row.channel,
    subject: row.subject,
    body: row.body,
  }));
}
