import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';

/** Outbox consumer name; producers route notification deliveries here (ADR 0011). */
export const NOTIFICATIONS_CONSUMER = 'notifications';

export type NotificationChannel = 'PUSH' | 'EMAIL' | 'INBOX';
export type NotificationLocale = 'en' | 'hi' | 'te';
export type NotificationCategory =
  'ORDER_UPDATES' | 'PAYMENTS' | 'WALLET' | 'RIDING' | 'STORE_OPS' | 'ADMIN' | 'PROMOTIONS';
export type NotificationClass = 'TRANSACTIONAL' | 'PROMOTIONAL';
export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'QUIET_HELD';

/**
 * Outbox consumer (DB effects only; runs inside consumeOnce's transaction).
 * Unknown event types and unresolvable payloads are skipped gracefully —
 * the delivery completes and notification work never fails its producer.
 */
export const NOTIFICATION_PIPELINE = Symbol('NOTIFICATION_PIPELINE');
export interface NotificationPipeline {
  consume(tx: TransactionContext, event: EventEnvelope): Promise<void>;
  /**
   * One provider attempt for one durable delivery row. 'RETRY' schedules a
   * bounded backoff; 'IDLE' means the row was already claimed or terminal.
   */
  deliverOnce(
    deliveryId: string,
    now?: Date,
  ): Promise<'SENT' | 'RETRY' | 'FAILED' | 'HELD' | 'IDLE'>;
  /** Re-enqueues due (or Redis-lost) deliveries; provider calls happen post-commit only. */
  enqueueDue(limit?: number): Promise<number>;
  /** Fan-out of an operational alert to explicit recipients (admin ops views). */
  notifyRecipient(input: {
    tx: TransactionContext;
    recipientIds: readonly string[];
    templateKey: string;
    category: NotificationCategory;
    class: NotificationClass;
    channels: readonly NotificationChannel[];
    data: Record<string, string>;
    dedupeContext: { eventType: string; aggregateId: string; transitionVersion: string };
  }): Promise<number>;
}

export interface NotificationView {
  id: string;
  channel: NotificationChannel;
  templateKey: string;
  title: string;
  body: string;
  category: NotificationCategory;
  class: NotificationClass;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  readAt: string | null;
  createdAt: string;
  sentAt: string | null;
}
export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
}
export const NOTIFICATION_VIEWS = Symbol('NOTIFICATION_VIEWS');
export interface NotificationViews {
  /** Keyset cursor pagination on (created_at DESC, id DESC); owner-filtered in SQL. */
  inbox(userId: string, cursor?: string, limit?: number): Promise<NotificationPage>;
  /** Another user's id is 404 RESOURCE_NOT_FOUND, never 403. */
  markRead(userId: string, notificationId: string): Promise<void>;
  markAllRead(userId: string): Promise<number>;
  unreadCount(userId: string): Promise<number>;
}

export interface DeviceTokenView {
  id: string;
  /** Masked: only a prefix/suffix is ever returned over the API. */
  token: string;
  platform: 'ANDROID' | 'IOS' | 'WEB';
  identifierType: 'FCM_TOKEN' | 'FID';
  app: 'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN';
  active: boolean;
  lastSeenAt: string;
}
export const DEVICE_TOKENS = Symbol('DEVICE_TOKENS');
export interface DeviceTokens {
  /** Conflicting token is reassigned to this user (login on a new device owner). */
  register(
    userId: string,
    input: {
      token: string;
      platform: 'ANDROID' | 'IOS' | 'WEB';
      app: 'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN';
      identifierType?: 'FCM_TOKEN' | 'FID';
    },
  ): Promise<void>;
  /** Owner-scoped delete; another user's token is 404 RESOURCE_NOT_FOUND. */
  unregister(userId: string, token: string): Promise<void>;
  list(userId: string): Promise<DeviceTokenView[]>;
}

export interface PreferenceView {
  category: NotificationCategory;
  enabled: boolean;
}
export const NOTIFICATION_PREFERENCES = Symbol('NOTIFICATION_PREFERENCES');
export interface NotificationPreferences {
  /** Missing rows mean enabled (opt-out model); the full category list is returned. */
  get(userId: string): Promise<PreferenceView[]>;
  set(
    userId: string,
    updates: { category: NotificationCategory; enabled: boolean }[],
  ): Promise<void>;
}

/** Provider ports. Adapters translate vendor errors to typed failures only. */
export const EMAIL_PORT = Symbol('EMAIL_PORT');
export interface EmailMessage {
  to: string;
  messageId?: string;
  subject: string;
  body: string;
}
export interface EmailSendResult {
  messageId: string | null;
}
export interface EmailPort {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface PushPayload {
  title: string;
  body: string;
  deepLink: string | null;
  data: Record<string, string>;
  priority: 'HIGH' | 'NORMAL';
  imageUrl?: string;
}
export interface PushTokenResult {
  token: string;
  ok: boolean;
  /** Provider rejected this registration; the caller must deactivate it. */
  invalidToken: boolean;
  /** False marks a permanent provider rejection; omitted means retryable. */
  retryable?: boolean;
  retryAfterMs?: number;
  messageId: string | null;
  error: string | null;
}
export const PUSH_PORT = Symbol('PUSH_PORT');
export interface PushPort {
  /** Bounded multicast (≤500 per call); one result per input token, in order. */
  send(
    tokens: readonly string[],
    payload: PushPayload,
    identifierType?: 'FCM_TOKEN' | 'FID',
  ): Promise<PushTokenResult[]>;
}

export const SMS_PORT = Symbol('SMS_PORT');
export interface SmsMessageResult {
  messageId: string;
}
export interface SmsPort {
  /** Disabled capability: always throws FEATURE_DISABLED, never used by the pipeline. */
  send(to: string, template: string, data: Record<string, string>): Promise<SmsMessageResult>;
}
