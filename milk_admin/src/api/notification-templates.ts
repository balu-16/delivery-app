import { get, put } from './http'

// ── Notification templates (customize2 §3E): versioned overrides ────────────
export interface NotificationTemplateEntry {
  templateKey: string
  locale: 'en' | 'hi' | 'te'
  channel: 'PUSH' | 'EMAIL' | 'INBOX'
  subject: string
  body: string
  version: number
  source: 'default' | 'override'
  placeholders: string[]
  preview: { subject: string; body: string }
}

export interface NotificationTemplateHistoryEntry {
  id: string
  version: number
  subject: string
  body: string
  updated_by: string | null
  created_at: string
}

export function listNotificationTemplates(): Promise<NotificationTemplateEntry[]> {
  return get<NotificationTemplateEntry[]>('/v1/admin/notification-templates')
}

export interface NotificationTemplateWriteInput {
  subject: string
  body: string
  expectedVersion: number
}

export function writeNotificationTemplate(
  templateKey: string,
  locale: string,
  channel: string,
  input: NotificationTemplateWriteInput,
): Promise<NotificationTemplateEntry> {
  return put<NotificationTemplateEntry>(
    `/v1/admin/notification-templates/${encodeURIComponent(templateKey)}/${locale}/${channel}`,
    input,
  )
}

export function getNotificationTemplateHistory(
  templateKey: string,
  locale: string,
  channel: string,
): Promise<NotificationTemplateHistoryEntry[]> {
  return get<NotificationTemplateHistoryEntry[]>(
    `/v1/admin/notification-templates/${encodeURIComponent(templateKey)}/${locale}/${channel}/history`,
  )
}
