import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import {
  permittedPlaceholders,
  renderTemplate,
  sampleDataFor,
  validatePlaceholders,
} from '../domain/render.js';
import type {
  TemplateEntry,
  TemplateOverrides,
  TemplateWrite,
} from '../contracts/template-overrides.js';

export type { TemplateEntry, TemplateWrite } from '../contracts/template-overrides.js';

/** Versioned template overrides (customize2 §3E): defaults stay in
 * notification_templates; edits land here and win during loadTemplates. */
export class PostgresTemplateOverrides implements TemplateOverrides {
  constructor(private readonly db: Database) {}

  private assertKey(templateKey: string, locale: string, channel: string): void {
    if (!/^[a-z0-9_.]{1,80}$/.test(templateKey)) throw new Error('INVALID_INPUT');
    if (!['en', 'hi', 'te'].includes(locale)) throw new Error('INVALID_INPUT');
    if (!['PUSH', 'EMAIL', 'INBOX'].includes(channel)) throw new Error('INVALID_INPUT');
  }

  async list(): Promise<TemplateEntry[]> {
    const defaults = await sql<{
      template_key: string;
      locale: string;
      channel: string;
      subject: string;
      body: string;
      version: number;
    }>`SELECT template_key,locale,channel,subject,body,version FROM notification_templates ORDER BY template_key,locale,channel`.execute(
      this.db,
    );
    const overrides = await sql<{
      template_key: string;
      locale: string;
      channel: string;
      subject: string;
      body: string;
      version: number;
    }>`SELECT template_key,locale,channel,subject,body,version FROM notification_template_overrides ORDER BY template_key,locale,channel`.execute(
      this.db,
    );
    const toEntry = (
      row: (typeof defaults.rows)[number],
      source: 'default' | 'override',
    ): TemplateEntry => {
      const sample = sampleDataFor(row.template_key);
      return {
        templateKey: row.template_key,
        locale: row.locale as TemplateEntry['locale'],
        channel: row.channel as TemplateEntry['channel'],
        subject: row.subject,
        body: row.body,
        version: row.version,
        source,
        placeholders: [...permittedPlaceholders(row.template_key)].sort(),
        preview: {
          subject: renderTemplate(row.subject, sample),
          body: renderTemplate(row.body, sample),
        },
      };
    };
    const byKey = new Map<string, TemplateEntry>();
    for (const row of defaults.rows)
      byKey.set(`${row.template_key}|${row.locale}|${row.channel}`, toEntry(row, 'default'));
    for (const row of overrides.rows)
      byKey.set(`${row.template_key}|${row.locale}|${row.channel}`, toEntry(row, 'override'));
    return [...byKey.values()].sort(
      (a, b) =>
        a.templateKey.localeCompare(b.templateKey) ||
        a.locale.localeCompare(b.locale) ||
        a.channel.localeCompare(b.channel),
    );
  }

  async write(
    actor: string,
    templateKey: string,
    locale: string,
    channel: string,
    input: TemplateWrite,
  ): Promise<TemplateEntry> {
    this.assertKey(templateKey, locale, channel);
    const subject = input.subject;
    const body = input.body;
    if (!subject || subject.length > 200 || !body || body.length > 2000)
      throw new Error('INVALID_INPUT');
    const { unknown } = validatePlaceholders(templateKey, subject, body);
    if (unknown.length) throw new Error('INVALID_INPUT');
    // Only supported keys are editable (a key exists in defaults).
    const seeded =
      await sql`SELECT template_key FROM notification_templates WHERE template_key=${templateKey} LIMIT 1`.execute(
        this.db,
      );
    if (!seeded.rows.length) throw new Error('INVALID_INPUT');
    return this.db.transaction().execute(async (tx) => {
      const allowed =
        await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actor}::uuid AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') LIMIT 1`.execute(
          tx,
        );
      if (!allowed.rows.length) throw new Error('FORBIDDEN');
      const existing = await sql<{
        subject: string;
        body: string;
        version: number;
      }>`SELECT subject,body,version FROM notification_template_overrides WHERE template_key=${templateKey} AND locale=${locale} AND channel=${channel}`.execute(
        tx,
      );
      const current = existing.rows[0];
      const expected = input.expectedVersion ?? 0;
      if ((current?.version ?? 0) !== expected) throw new Error('CONCURRENT_MODIFICATION');
      if (current) {
        await sql`INSERT INTO notification_template_history(id,template_key,locale,channel,version,subject,body,updated_by) VALUES(${uuidV7()}::uuid,${templateKey},${locale},${channel},${current.version},${current.subject},${current.body},${actor}::uuid)`.execute(
          tx,
        );
      }
      const version = (current?.version ?? 0) + 1;
      const upserted = await sql<{
        template_key: string;
        locale: string;
        channel: string;
        subject: string;
        body: string;
        version: number;
      }>`INSERT INTO notification_template_overrides(template_key,locale,channel,subject,body,version,updated_by,updated_at) VALUES(${templateKey},${locale},${channel},${subject},${body},${version},${actor}::uuid,clock_timestamp()) ON CONFLICT (template_key,locale,channel) DO UPDATE SET subject=EXCLUDED.subject,body=EXCLUDED.body,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING template_key,locale,channel,subject,body,version`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${actor}::uuid,'NOTIFICATION_TEMPLATE_WRITTEN','notification_template',${`${templateKey}:${locale}:${channel}`},${JSON.stringify({ before: current ?? null, after: upserted.rows[0] as unknown })}::jsonb)`.execute(
        tx,
      );
      const row = upserted.rows[0] as unknown as {
        template_key: string;
        locale: string;
        channel: string;
        subject: string;
        body: string;
        version: number;
      };
      const sample = sampleDataFor(templateKey);
      return {
        templateKey: row.template_key,
        locale: row.locale as TemplateEntry['locale'],
        channel: row.channel as TemplateEntry['channel'],
        subject: row.subject,
        body: row.body,
        version: row.version,
        source: 'override' as const,
        placeholders: [...permittedPlaceholders(templateKey)].sort(),
        preview: {
          subject: renderTemplate(row.subject, sample),
          body: renderTemplate(row.body, sample),
        },
      };
    });
  }

  async history(templateKey: string, locale: string, channel: string) {
    this.assertKey(templateKey, locale, channel);
    const rows = await sql<{
      id: string;
      version: number;
      subject: string;
      body: string;
      updated_by: string | null;
      created_at: string;
    }>`SELECT id,version,subject,body,updated_by,created_at::text AS created_at FROM notification_template_history WHERE template_key=${templateKey} AND locale=${locale} AND channel=${channel} ORDER BY version DESC LIMIT 50`.execute(
      this.db,
    );
    return rows.rows;
  }
}
