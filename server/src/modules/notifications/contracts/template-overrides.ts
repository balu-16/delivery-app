export interface TemplateEntry {
  templateKey: string;
  locale: 'en' | 'hi' | 'te';
  channel: 'PUSH' | 'EMAIL' | 'INBOX';
  subject: string;
  body: string;
  version: number;
  source: 'default' | 'override';
  placeholders: string[];
  preview: { subject: string; body: string };
}

export interface TemplateWrite {
  subject: string;
  body: string;
  expectedVersion?: number;
}

export interface TemplateHistoryEntry {
  id: string;
  version: number;
  subject: string;
  body: string;
  updated_by: string | null;
  created_at: string;
}

export const TEMPLATE_OVERRIDES = Symbol('TEMPLATE_OVERRIDES');

/** Versioned notification-template overrides; defaults stay in notification_templates. */
export interface TemplateOverrides {
  list(): Promise<TemplateEntry[]>;
  write(
    actor: string,
    templateKey: string,
    locale: string,
    channel: string,
    input: TemplateWrite,
  ): Promise<TemplateEntry>;
  history(templateKey: string, locale: string, channel: string): Promise<TemplateHistoryEntry[]>;
}
