import type { NotificationLocale } from '../contracts/notifications.js';

const PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}\}/g;

/**
 * Replaces {{name}} placeholders; unknown placeholders render empty so
 * payload shape changes can never leak template syntax to users.
 */
export function renderTemplate(body: string, data: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (_match, key: string) => {
    const value = data[key];
    return value === undefined ? '' : String(value).slice(0, 500);
  });
}

/** Locale fallback: the requested locale when supported, else 'en'. */
export function resolveLocale(requested: string | null | undefined): NotificationLocale {
  return requested === 'hi' || requested === 'te' ? requested : 'en';
}

export interface TemplateRow {
  templateKey: string;
  locale: NotificationLocale;
  channel: string;
  subject: string;
  body: string;
}

/**
 * Picks (key, channel, locale) and falls back to the 'en' row for the same
 * key+channel; falls back across channels only as a last resort (INBOX row)
 * so a missing channel seed never fails delivery.
 */
export function selectTemplate(
  templates: readonly TemplateRow[],
  key: string,
  channel: string,
  locale: NotificationLocale,
): TemplateRow | null {
  const forChannel = (row: TemplateRow) => row.templateKey === key && row.channel === channel;
  return (
    templates.find((row) => forChannel(row) && row.locale === locale) ??
    templates.find((row) => forChannel(row) && row.locale === 'en') ??
    templates.find(
      (row) => row.templateKey === key && row.channel === 'INBOX' && row.locale === 'en',
    ) ??
    null
  );
}
