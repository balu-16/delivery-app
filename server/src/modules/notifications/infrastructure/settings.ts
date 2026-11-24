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

/** Loads template rows for rendering (small table; read per send batch).
 * Versioned overrides (customize2 §3E) win over notification_templates
 * defaults; defaults are retained for keys without an override. */
export async function loadTemplates(
  client: Database | TransactionContext,
  keys: readonly string[],
): Promise<TemplateRow[]> {
  if (!keys.length) return [];
  const defaults = await sql<{
    template_key: string;
    locale: string;
    channel: string;
    subject: string;
    body: string;
  }>`SELECT template_key,locale,channel,subject,body FROM notification_templates WHERE template_key = ANY(${keys}::text[])`.execute(
    client,
  );
  const overrides = await sql<{
    template_key: string;
    locale: string;
    channel: string;
    subject: string;
    body: string;
  }>`SELECT template_key,locale,channel,subject,body FROM notification_template_overrides WHERE template_key = ANY(${keys}::text[])`.execute(
    client,
  );
  const byKey = new Map<string, TemplateRow>();
  for (const row of defaults.rows) {
    byKey.set(`${row.template_key}|${row.locale}|${row.channel}`, {
      templateKey: row.template_key,
      locale: row.locale as TemplateRow['locale'],
      channel: row.channel,
      subject: row.subject,
      body: row.body,
    });
  }
  for (const row of overrides.rows) {
    byKey.set(`${row.template_key}|${row.locale}|${row.channel}`, {
      templateKey: row.template_key,
      locale: row.locale as TemplateRow['locale'],
      channel: row.channel,
      subject: row.subject,
      body: row.body,
    });
  }
  return [...byKey.values()];
}
